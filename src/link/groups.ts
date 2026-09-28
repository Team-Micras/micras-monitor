import {
  MAX_GROUP_VARIABLES,
  MAX_GROUPS,
  MAX_PAYLOAD_SIZE,
  readValue,
  TYPE_SIZE,
  TypeCode,
} from '../protocol';
import type { SchemaEntry } from './schema';

/** The group, sequence number and timestamp in front of the values of a sample. */
export const SAMPLE_HEADER_SIZE = 7;

/** A set of variables to stream together, sampled in the same loop iteration. */
export interface GroupRequest {
  /** The variables, in the order their values are packed. */
  readonly variableIds: readonly number[];

  /** How many loop iterations between two samples. */
  readonly periodTicks: number;
}

/** A group request checked against the schema, ready to be sent. */
export interface GroupLayout extends GroupRequest {
  /** The slot on the robot, which is the position of the request. */
  readonly group: number;

  /** The type of each variable. */
  readonly types: readonly TypeCode[];

  /** The bytes of the values of one sample. */
  readonly sampleSize: number;
}

/**
 * One definition of a group, from the robot enabling it until the group is defined again, turned
 * off or lost with the session. The robot restarts the sequence of a group every time it is
 * defined, so a sequence number only means something inside its epoch.
 */
export interface Epoch {
  /** Unique across sessions sharing an id source, never reused. */
  readonly id: number;
  readonly group: number;
  readonly variableIds: readonly number[];
  /** The period the robot acknowledged. */
  readonly periodTicks: number;
  /** The sample size the robot acknowledged. */
  readonly sampleSize: number;
  /** The run of the robot's clock its times belong to; it changes when the robot's clock restarts. */
  readonly timeline: number;
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
  /** Configuring the group failed, so what the robot does with it is not known. */
  | 'failed'
  /** The robot's clock started over while the group streamed, which opens a new timeline. */
  | 'clock-reset';

/** Hands out epoch ids. */
export type EpochIdSource = () => number;

let lastSharedEpochId = 0;

/**
 * The id source sessions use unless given one: a counter shared by every session on the page, so
 * that a store holding epochs of several sessions never sees two with the same id.
 */
export const sharedEpochIds: EpochIdSource = () => ++lastSharedEpochId;

/** Told when epochs begin and end. */
export interface EpochListener {
  opened(epoch: Epoch): void;
  ended(epoch: Epoch, reason: EpochEndReason): void;
}

/** A decoded value: booleans as 0 or 1, 64 bit integers as `bigint`. */
export type SampleValue = number | bigint;

/**
 * Check a set of group requests against the schema and the robot's limits.
 *
 * @param schema The robot's schema.
 * @param requests One request per group, at most `MAX_GROUPS`.
 * @returns The layouts to send.
 * @throws If a request cannot be streamed as asked.
 */
export function planGroups(
  schema: readonly SchemaEntry[],
  requests: readonly GroupRequest[]
): GroupLayout[] {
  if (requests.length > MAX_GROUPS) {
    throw new Error(`The robot holds ${MAX_GROUPS} groups, ${requests.length} were asked for`);
  }

  return requests.map((request, group) => planGroup(schema, request, group));
}

function planGroup(
  schema: readonly SchemaEntry[],
  request: GroupRequest,
  group: number
): GroupLayout {
  const { variableIds, periodTicks } = request;

  if (variableIds.length === 0 || variableIds.length > MAX_GROUP_VARIABLES) {
    throw new Error(`Group ${group} must have 1 to ${MAX_GROUP_VARIABLES} variables`);
  }

  if (!Number.isInteger(periodTicks) || periodTicks < 1 || periodTicks > 0xffff) {
    throw new Error(`Group ${group} period must be 1 to 65535 ticks, got ${periodTicks}`);
  }

  const types = variableIds.map((id) => streamableType(schema, id));
  const sampleSize = types.reduce((total, type) => total + TYPE_SIZE[type], 0);

  if (sampleSize + SAMPLE_HEADER_SIZE > MAX_PAYLOAD_SIZE) {
    throw new Error(`Group ${group} samples would take ${sampleSize} bytes, too many for a frame`);
  }

  return { group, variableIds: [...variableIds], periodTicks, types, sampleSize };
}

function streamableType(schema: readonly SchemaEntry[], id: number): TypeCode {
  const entry = schema[id] as SchemaEntry | undefined;

  if (!entry) {
    throw new Error(`No variable ${id} in the schema`);
  }

  if (!entry.access.stream || entry.type === TypeCode.BLOB) {
    throw new Error(`${entry.name} cannot be streamed`);
  }

  return entry.type;
}

/**
 * Whether a layout is what an open epoch already streams.
 */
export function sameLayout(layout: GroupLayout, epoch: Epoch): boolean {
  return (
    layout.group === epoch.group &&
    layout.periodTicks === epoch.periodTicks &&
    layout.variableIds.length === epoch.variableIds.length &&
    layout.variableIds.every((id, index) => epoch.variableIds[index] === id)
  );
}

/**
 * An epoch that samples are arriving for: it decodes them and counts the ones the robot dropped.
 */
export class OpenEpoch {
  private expectedSeq = 0;
  private announced = false;

  constructor(
    readonly epoch: Epoch,
    private readonly types: readonly TypeCode[]
  ) {}

  /** Whether the robot enabled the group, which is when the epoch is announced. */
  get active(): boolean {
    return this.announced;
  }

  /** Mark the epoch announced. */
  announce(): void {
    this.announced = true;
  }

  /**
   * Carry on the same stream as another epoch, such as on a new timeline, expecting the sequence
   * number this one expects next.
   *
   * @param epoch The epoch that takes over.
   * @returns Its open epoch, not yet announced.
   */
  continueAs(epoch: Epoch): OpenEpoch {
    const next = new OpenEpoch(epoch, this.types);
    next.expectedSeq = this.expectedSeq;
    return next;
  }

  /**
   * Account for the sequence number of a sample.
   *
   * @param seq The u16 sequence number the sample carries.
   * @returns How many samples went missing just before it.
   */
  advance(seq: number): number {
    const missing = (seq - this.expectedSeq) & 0xffff;
    this.expectedSeq = (seq + 1) & 0xffff;
    return missing;
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

    for (const type of this.types) {
      values.push(asSampleValue(readValue(bytes, offset, type)));
      offset += TYPE_SIZE[type];
    }

    return values;
  }
}

function asSampleValue(value: ReturnType<typeof readValue>): SampleValue {
  if (typeof value === 'boolean') {
    return value ? 1 : 0;
  }

  return typeof value === 'number' || typeof value === 'bigint' ? value : Number.NaN;
}

/**
 * The epoch each group is in. It is the one place epochs begin and end, and it tells its listener
 * about both.
 *
 * An epoch begins when the robot acknowledges the definition, so that samples are decoded with
 * the layout the robot uses, and is announced once the robot enables the group.
 */
export class EpochRegistry {
  private readonly groups = new Map<number, OpenEpoch>();

  /**
   * @param listener Told when an announced epoch begins or ends.
   * @param nextId Where epoch ids come from.
   */
  constructor(
    private readonly listener: EpochListener,
    private readonly nextId: EpochIdSource = sharedEpochIds
  ) {}

  /**
   * Start the epoch a definition opens, ending the one the group was in.
   *
   * @param layout What was defined.
   * @param periodTicks The period the robot acknowledged.
   * @param sampleSize The sample size the robot acknowledged.
   * @param timeline The run of the robot's clock it belongs to.
   */
  define(
    layout: GroupLayout,
    periodTicks: number,
    sampleSize: number,
    timeline: number
  ): OpenEpoch {
    this.end(layout.group, 'redefined');

    const epoch: Epoch = {
      id: this.nextId(),
      group: layout.group,
      variableIds: layout.variableIds,
      periodTicks,
      sampleSize,
      timeline,
    };
    const open = new OpenEpoch(epoch, layout.types);

    this.groups.set(layout.group, open);
    return open;
  }

  /** Announce the epoch of a group, once the robot enabled it. */
  activate(group: number): void {
    const open = this.groups.get(group);

    if (open && !open.active) {
      open.announce();
      this.listener.opened(open.epoch);
    }
  }

  /** The epoch a group is in, announced or not. */
  current(group: number): OpenEpoch | undefined {
    return this.groups.get(group);
  }

  /** Whether a group streams in an announced epoch. */
  isActive(group: number): boolean {
    return this.groups.get(group)?.active ?? false;
  }

  /** End the epoch of a group, if it has one. */
  end(group: number, reason: EpochEndReason): void {
    const open = this.groups.get(group);

    if (!open) {
      return;
    }

    this.groups.delete(group);

    if (open.active) {
      this.listener.ended(open.epoch, reason);
    }
  }

  /** End every epoch. */
  endAll(reason: EpochEndReason): void {
    for (const group of this.groups.keys()) {
      this.end(group, reason);
    }
  }

  /**
   * Move every announced epoch onto a new timeline: each one ends as `clock-reset` and a new one
   * carries on its stream, with the same layout and the same sequence.
   *
   * @param timeline The timeline the new epochs belong to.
   */
  moveToTimeline(timeline: number): void {
    for (const [group, open] of this.groups) {
      if (!open.active) {
        continue;
      }

      this.groups.set(group, open.continueAs({ ...open.epoch, id: this.nextId(), timeline }));
      this.listener.ended(open.epoch, 'clock-reset');
      this.activate(group);
    }
  }

  /** Every announced epoch, by group. */
  active(): Epoch[] {
    return [...this.groups.values()]
      .filter((open) => open.active)
      .map((open) => open.epoch)
      .toSorted((a, b) => a.group - b.group);
  }
}
