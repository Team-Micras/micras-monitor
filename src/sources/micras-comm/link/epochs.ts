import { readValue, TYPE_SIZE, TypeCode } from '../wire';
import { TimestampUnwrapper } from './clock';
import type { GroupLayout } from './group-configurator';
import type { LinkContext, ReadResult, TimelineEvent } from './link-events';
import type { GroupAck, Sample } from './messages';
import type { SchemaEntry } from './schema';

const U32_HALF_RANGE = 2 ** 31;
const LONG_GAP = 1024;
const GAP_TOLERANCE = 0.05;

/**
 * How much longer than the monitor's own clock the robot's may have run between two samples
 * arriving, in microseconds: the one may have waited on the way for up to this much longer than
 * the other.
 */
const ARRIVAL_SLACK_US = 1_000_000;

/**
 * One definition of a group, from the robot enabling it until the group is defined again, turned
 * off or lost with the link. The robot restarts the sequence of a group every time it is
 * defined, so a sequence number only means something inside its epoch.
 */
export interface Epoch {
  /** Unique across the links of the page, never reused. */
  readonly id: number;
  readonly group: number;
  readonly variableIds: readonly number[];
  /** The period the robot acknowledged. */
  readonly periodTicks: number;
  /** The sample size the robot acknowledged. */
  readonly sampleSize: number;
  /** The run of the robot's clock its times belong to; it changes when the robot's clock restarts. */
  readonly timeline: number;
  /**
   * The epoch whose stream this one carries on: the group went out of step and was defined again
   * with the same variables, on the same timeline, so what the robot took in between is samples
   * dropped from one stream rather than a stream that ended.
   */
  readonly continues?: number;
}

/** Why an epoch ended. */
export type EpochEndReason =
  /** The group was defined again, with a new layout or the same one. */
  | 'redefined'
  /** The group was turned off. */
  | 'disabled'
  /** The handshake was redone, which makes the robot forget every group. */
  | 'restarted'
  /** The transport dropped. */
  | 'disconnected'
  /** Samples arrived that the definition cannot have sent, so the robot streams something else. */
  | 'out-of-step'
  /** Configuring the group failed, so what the robot does with it is not known. */
  | 'failed'
  /** The robot's clock started over while the group streamed, which opens a new timeline. */
  | 'clock-reset';

/** A decoded value: booleans as 0 or 1, 64 bit integers as `bigint`. */
export type SampleValue = number | bigint;

/** What became of a sample: taken into its epoch, or showing the group needs defining again. */
export type SampleOutcome =
  /** It belongs to its epoch and was emitted. */
  | 'accepted'
  /** Its group has no epoch, so the robot streams a group nobody asked for. */
  | 'stray'
  /** Its epoch cannot have sent it, so the epoch ended and the group has to be defined again. */
  | 'out-of-step';

let lastEpochId = 0;

/**
 * The next epoch id, from a counter shared by every link on the page, so that a store holding
 * epochs of several links never sees two with the same id.
 */
function nextEpochId(): number {
  return ++lastEpochId;
}

/**
 * An epoch that samples are arriving for: it decodes them and counts the ones the robot dropped.
 */
export class OpenEpoch {
  readonly epoch: Epoch;
  readonly #types: readonly TypeCode[];
  #expectedSeq = 0;
  #lastTimestampUs: number | undefined;
  #lastArrivedMs: number | undefined;
  #carried: number;
  #announced = false;

  /**
   * @param epoch What the robot acknowledged.
   * @param types The type of each variable, in the order of the values.
   * @param carried Samples dropped before the epoch began that its first sample reports, as those
   *   of the epoch it continues.
   */
  constructor(epoch: Epoch, types: readonly TypeCode[], carried = 0) {
    this.epoch = epoch;
    this.#types = types;
    this.#carried = carried;
  }

  /** Whether the robot enabled the group, which is when the epoch is announced. */
  get active(): boolean {
    return this.#announced;
  }

  /** Mark the epoch announced. */
  announce(): void {
    this.#announced = true;
  }

  /**
   * Carry on the same stream as another epoch, such as on a new timeline, expecting the sequence
   * number this one expects next.
   *
   * @param epoch The epoch that takes over.
   * @returns Its open epoch, not yet announced.
   */
  continueAs(epoch: Epoch): OpenEpoch {
    const next = new OpenEpoch(epoch, this.#types, this.#carried);
    next.#expectedSeq = this.#expectedSeq;
    next.#lastTimestampUs = this.#lastTimestampUs;
    next.#lastArrivedMs = this.#lastArrivedMs;
    return next;
  }

  /** The sequence number the next sample should carry. */
  get nextSeq(): number {
    return this.#expectedSeq;
  }

  /**
   * Account for the sequence number of a sample. A number less than 1024 ahead of the expected one
   * follows samples that went missing. One further ahead is either a long gap, a sample behind the
   * expected one, which this epoch already had or never sent, or a number the frame check let
   * through corrupted; the time since the last sample settles which, and a sample the time does
   * not bear out moves nothing.
   *
   * @param seq The u16 sequence number the sample carries.
   * @param timestampUs The u32 timestamp the robot gave it.
   * @param spacingUs How far apart in time the robot takes the samples of the group; 0 if unknown.
   * @param nowMs When it arrived, in milliseconds of the monitor's clock.
   * @returns How many samples went missing just before it, or null when it is out of step.
   */
  accept(seq: number, timestampUs: number, spacingUs: number, nowMs: number): number | null {
    const missing = (seq - this.#expectedSeq) & 0xffff;

    if (missing >= LONG_GAP && !this.#timeSpans(missing, timestampUs, spacingUs)) {
      return null;
    }

    this.#expectedSeq = (seq + 1) & 0xffff;
    this.#lastTimestampUs = timestampUs;
    this.#lastArrivedMs = nowMs;
    return missing;
  }

  /**
   * How many samples the robot took between the last sample accepted and a moment, by the time;
   * the ones lost when the epoch ends out of step there. The robot's time counts no further than
   * the monitor's own clock allows, since a timestamp the frame check let through corrupted can
   * be anything.
   *
   * @param timestampUs The u32 timestamp of the moment.
   * @param spacingUs How far apart in time the robot takes the samples of the group; 0 if unknown.
   * @param nowMs When the moment arrived, in milliseconds of the monitor's clock.
   * @returns The samples, 0 when the time says nothing.
   */
  takenSince(timestampUs: number, spacingUs: number, nowMs: number): number {
    const elapsed = this.#elapsedUs(timestampUs);

    if (elapsed === null || spacingUs <= 0 || this.#lastArrivedMs === undefined) {
      return 0;
    }

    const possibleUs = (nowMs - this.#lastArrivedMs) * 1000 + ARRIVAL_SLACK_US;
    return Math.floor(Math.min(elapsed, possibleUs) / spacingUs);
  }

  /**
   * The samples dropped before the epoch began that the next sample reports, given once.
   */
  takeCarried(): number {
    const carried = this.#carried;
    this.#carried = 0;
    return carried;
  }

  /**
   * Read the values of a sample.
   *
   * @param bytes The bytes after the sample header.
   * @returns One value per variable, or null when the size is not the acknowledged one.
   */
  decode(bytes: Uint8Array): SampleValue[] | null {
    if (bytes.length !== this.epoch.sampleSize) {
      return null;
    }

    const values: SampleValue[] = [];
    let offset = 0;

    for (const type of this.#types) {
      values.push(asSampleValue(readValue(bytes, offset, type)));
      offset += TYPE_SIZE[type];
    }

    return values;
  }

  #timeSpans(missing: number, timestampUs: number, spacingUs: number): boolean {
    const elapsed = this.#elapsedUs(timestampUs);

    if (elapsed === null || spacingUs <= 0) {
      return false;
    }

    const skipped = Math.round(elapsed / spacingUs) - 1;
    return Math.abs(skipped - missing) <= missing * GAP_TOLERANCE;
  }

  #elapsedUs(timestampUs: number): number | null {
    if (this.#lastTimestampUs === undefined) {
      return null;
    }

    const elapsed = (timestampUs - this.#lastTimestampUs) >>> 0;
    return elapsed < U32_HALF_RANGE ? elapsed : null;
  }
}

/**
 * The epoch each group is in, and the samples that arrive for them. It is the one place epochs
 * begin and end, and it emits both, with every sample and the samples dropped.
 *
 * An epoch begins when the robot acknowledges the definition, so that samples are decoded with
 * the layout the robot uses, and is announced once the robot enables the group. The registry also
 * keeps the robot's clock: the timelines its timestamps run on, and how they unwrap past the u32
 * range.
 */
export class EpochRegistry {
  readonly #context: LinkContext;
  readonly #groups = new Map<number, OpenEpoch>();
  readonly #outOfStep = new Map<number, { readonly epoch: Epoch; readonly lost: number }>();
  readonly #clock = new TimestampUnwrapper();
  #timeline = 0;
  #active: readonly Epoch[] | null = null;

  /**
   * @param context What the registry shares with its link.
   */
  constructor(context: LinkContext) {
    this.#context = context;
  }

  /**
   * Start a new run of the robot's clock, which the epochs defined from now on belong to. A
   * reboot also forgets where the clock was, since it starts over.
   *
   * @param reason The first contact, or a new boot id in the handshake.
   */
  beginTimeline(reason: Exclude<TimelineEvent['reason'], 'clock-reset'>): void {
    if (reason === 'reboot') {
      this.#clock.reset();
    }

    this.#newTimeline(reason);
  }

  /**
   * Place a timestamp the robot sends out of order with the samples, such as a LOG held for
   * credit, on the time of the samples.
   *
   * @param timestampUs The timestamp as the robot sent it.
   * @returns The time in microseconds since the robot's clock last started.
   */
  place(timestampUs: number): number {
    return this.#clock.place(timestampUs);
  }

  /**
   * Start the epoch a definition opens, ending the one the group was in. A group defined again
   * with the variables it had when it went out of step, on the same timeline, continues that
   * epoch's stream.
   *
   * @param layout What was defined.
   * @param ack What the robot acknowledged for it.
   * @returns The epoch, announced once the group is enabled.
   */
  define(layout: GroupLayout, ack: GroupAck): OpenEpoch {
    const previous = this.#outOfStep.get(layout.group);
    this.end(layout.group, 'redefined');

    const continued =
      previous !== undefined &&
      previous.epoch.timeline === this.#timeline &&
      sameIds(previous.epoch.variableIds, layout.variableIds)
        ? previous
        : undefined;
    const epoch: Epoch = {
      id: nextEpochId(),
      group: layout.group,
      variableIds: layout.variableIds,
      periodTicks: ack.periodTicks,
      sampleSize: ack.sampleSize,
      timeline: this.#timeline,
      ...(continued && { continues: continued.epoch.id }),
    };
    const open = new OpenEpoch(epoch, layout.types, continued?.lost ?? 0);

    this.#groups.set(layout.group, open);
    return open;
  }

  /** Announce the epoch of a group, once the robot enabled it. */
  activate(group: number): void {
    const open = this.#groups.get(group);

    if (open && !open.active) {
      open.announce();
      this.#active = null;
      this.#context.emit('epoch', open.epoch);
    }
  }

  /** The epoch a group is in, announced or not. */
  current(group: number): OpenEpoch | undefined {
    return this.#groups.get(group);
  }

  /** Whether a group streams in an announced epoch. */
  isActive(group: number): boolean {
    return this.#groups.get(group)?.active ?? false;
  }

  /** End the epoch of a group, if it has one. */
  end(group: number, reason: EpochEndReason): void {
    this.#outOfStep.delete(group);
    const open = this.#groups.get(group);

    if (!open) {
      return;
    }

    this.#groups.delete(group);

    if (open.active) {
      this.#active = null;
      this.#context.emit('epochEnd', { epoch: open.epoch, reason });
    }
  }

  /** End every epoch. */
  endAll(reason: EpochEndReason): void {
    for (const group of this.#groups.keys()) {
      this.end(group, reason);
    }

    this.#outOfStep.clear();
  }

  /** Every announced epoch, by group; the same array until one begins or ends. */
  active(): readonly Epoch[] {
    this.#active ??= Object.freeze(
      [...this.#groups.values()]
        .filter((open) => open.active)
        .map((open) => open.epoch)
        .toSorted((a, b) => a.group - b.group)
    );
    return this.#active;
  }

  /**
   * Take a sample into its epoch. A defined group only streams once enabled, and the robot sends
   * the GROUP_ACK of the enable ahead of the first sample, so a sample of an epoch not yet
   * announced announces it: its acknowledgement came first on the wire, even when the configurator
   * waiting for it has not run yet.
   *
   * A sample is checked against its epoch before anything is taken from it. One the epoch cannot
   * have sent, of another size or with a sequence the time does not bear out, means the robot
   * streams something else in the group, as when another monitor redefined it: it is reported and
   * left out, its time and sequence count for nothing, the samples the robot took for the epoch
   * since the last one accepted count as dropped, and the epoch ends.
   *
   * @param sample The sample as it arrived.
   * @param nowMs When it arrived, in milliseconds of the monitor's clock.
   * @param loopTimeUs The period of the robot's control loop.
   * @returns What became of it.
   */
  receive(sample: Sample, nowMs: number, loopTimeUs: number): SampleOutcome {
    const open = this.#groups.get(sample.group);

    if (!open) {
      return 'stray';
    }

    const spacingUs = open.epoch.periodTicks * loopTimeUs;
    const values = open.decode(sample.values);

    if (!values) {
      return this.#endOutOfStep(
        open,
        sample,
        spacingUs,
        nowMs,
        `A sample of group ${sample.group} has ${sample.values.length} bytes; ${open.epoch.sampleSize} were acknowledged`
      );
    }

    const expected = open.nextSeq;
    const missing = open.accept(sample.seq, sample.timestampUs, spacingUs, nowMs);

    if (missing === null) {
      return this.#endOutOfStep(
        open,
        sample,
        spacingUs,
        nowMs,
        `A sample of group ${sample.group} came with sequence ${sample.seq}; ${expected} was expected`
      );
    }

    const timeUs = this.#unwrap(sample.timestampUs, nowMs);
    this.activate(sample.group);
    const current = this.#groups.get(sample.group) ?? open;

    this.#dropped(current.epoch, missing);
    this.#context.counters.add('samples');
    this.#context.emit('sample', {
      epoch: current.epoch.id,
      seq: sample.seq,
      timeUs,
      values,
      missingBefore: missing + current.takeCarried(),
    });
    return 'accepted';
  }

  #endOutOfStep(
    open: OpenEpoch,
    sample: Sample,
    spacingUs: number,
    nowMs: number,
    message: string
  ): SampleOutcome {
    const lost = open.active ? open.takenSince(sample.timestampUs, spacingUs, nowMs) : 0;

    this.#dropped(open.epoch, lost);
    this.#context.report(message);
    this.end(sample.group, 'out-of-step');

    if (open.active) {
      this.#outOfStep.set(sample.group, { epoch: open.epoch, lost });
    }

    return 'out-of-step';
  }

  #dropped(epoch: Epoch, count: number): void {
    if (count > 0) {
      this.#context.counters.add('droppedSamples', count);
      this.#context.emit('dropped', { epoch: epoch.id, count });
    }
  }

  /**
   * Unwrap a timestamp, and move the streams onto a new timeline when it shows the robot's clock
   * starting over.
   */
  #unwrap(timestampUs: number, nowMs: number): number {
    const resets = this.#clock.resets;
    const timeUs = this.#clock.unwrap(timestampUs, nowMs);

    if (this.#clock.resets !== resets) {
      this.#context.counters.set('clockResets', this.#clock.resets);
      this.#newTimeline('clock-reset');
      this.#moveToTimeline();
    }

    return timeUs;
  }

  #newTimeline(reason: TimelineEvent['reason']): void {
    this.#timeline++;
    this.#context.emit('timeline', { id: this.#timeline, reason });
  }

  /**
   * Move every epoch onto the current timeline: each one is replaced by a new one that carries on
   * its stream, with the same layout and the same sequence. An announced epoch ends as
   * `clock-reset` and its successor is announced; one not announced yet is replaced silently, so
   * that it is announced on the new timeline when its group is enabled.
   */
  #moveToTimeline(): void {
    this.#outOfStep.clear();

    for (const [group, open] of this.#groups) {
      const next = open.continueAs({ ...open.epoch, id: nextEpochId(), timeline: this.#timeline });
      this.#groups.set(group, next);

      if (open.active) {
        this.#active = null;
        this.#context.emit('epochEnd', { epoch: open.epoch, reason: 'clock-reset' });
        this.activate(group);
      }
    }
  }
}

/**
 * Read the answer to a READ as the type of its variable.
 *
 * @param entry The variable.
 * @param bytes What the VALUE carried.
 * @returns The value, or a copy of the bytes of a blob.
 */
export function decodeReadValue(entry: SchemaEntry, bytes: Uint8Array): ReadResult {
  if (entry.type === TypeCode.BLOB) {
    return bytes.slice();
  }

  const value = readValue(bytes, 0, entry.type);

  if (value === null) {
    throw new Error(`The value of ${entry.name} has ${bytes.length} bytes, too few for its type`);
  }

  return value;
}

function sameIds(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((id, index) => b[index] === id);
}

function asSampleValue(value: ReturnType<typeof readValue>): SampleValue {
  if (typeof value === 'boolean') {
    return value ? 1 : 0;
  }

  return typeof value === 'number' || typeof value === 'bigint' ? value : Number.NaN;
}
