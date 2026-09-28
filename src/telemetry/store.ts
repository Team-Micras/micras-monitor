import type { TypeCode } from '@/protocol';

import type { Block } from './block';
import { Decimation, decimateSegments, type DecimationStats, lowerBound } from './decimation';
import { Epoch } from './epoch';
import { ChangeNotifier, Channel } from './notifier';
import type { BlockPersistence } from './persistence';
import { LEAF_SIZE } from './pyramid';
import { BlockResidency } from './residency';
import type { Scheduler } from './scheduler';
import { type ColumnKind, columnKindOf, losesPrecision } from './storage';
import type {
  Boundary,
  BoundaryKind,
  EpochSpec,
  Gap,
  LatestValue,
  SampleRun,
  StoreStatus,
  TelemetryEvent,
  TelemetryValue,
} from './types';
import { VariableRecord } from './variable';

/** How many samples a block holds unless told otherwise. */
export const DEFAULT_BLOCK_SIZE = 65_536;

/** The memory cap unless told otherwise: 256 MiB. */
export const DEFAULT_MEMORY_CAP_BYTES = 256 * 1024 * 1024;

/**
 * How to set up a store.
 */
export interface TelemetryStoreOptions {
  /** When subscribers hear about changes: `requestAnimationFrame` in the application. */
  readonly scheduler: Scheduler;

  /**
   * How many samples a block holds at most: a power of two, at least 16. An epoch's first blocks
   * are smaller, from 1,024 samples up, so that short epochs take little memory.
   */
  readonly blockSize?: number;

  /** The most memory blocks may take. */
  readonly memoryCapBytes?: number;

  /** The share of the cap at which to warn while not recording; 0.8 by default. */
  readonly warningRatio?: number;

  /** Where the robot's sequence numbers wrap; 2¹⁶, a `u16` on the wire, by default. */
  readonly sequenceModulus?: number;

  /** How many values to keep for variables not stored numerically, such as blobs; 32. */
  readonly historyLength?: number;
}

/**
 * What the store knows about a variable.
 */
export interface VariableInfo {
  /** Its id in the schema. */
  readonly id: number;

  /** Its type, once an epoch named it. */
  readonly type: TypeCode | undefined;

  /** How its history is stored, or `none` for blobs. */
  readonly storage: ColumnKind | 'none' | undefined;

  /** Whether a 64 bit integer it held did not fit a float exactly. */
  readonly precisionLost: boolean;

  /** How many of its samples are stored. */
  readonly storedSamples: number;

  /** How many of its samples the sequence numbers show as lost. */
  readonly droppedSamples: number;

  /** How many epochs it was part of. */
  readonly epochs: number;
}

/**
 * Extra parameters of a decimation query.
 */
export interface DecimateOptions {
  /** Reuse this decimation instead of making one. */
  readonly into?: Decimation;

  /** Add what the query read to these counters. */
  readonly stats?: DecimationStats;
}

/**
 * A span of time.
 */
export interface TimeRange {
  /** The first time, inclusive. */
  readonly startUs: number;

  /** The last time, inclusive. */
  readonly endUs: number;
}

const NO_VALUES: readonly LatestValue[] = [];

interface OpenEpoch {
  readonly epoch: Epoch;
  readonly records: readonly VariableRecord[];
}

function checkBlockSize(size: number): number {
  if (!Number.isInteger(size) || size < LEAF_SIZE || (size & (size - 1)) !== 0) {
    throw new RangeError(`Block size must be a power of two of at least ${LEAF_SIZE}, got ${size}`);
  }

  return size;
}

function overlaps(startUs: number, endUs: number, fromUs: number, toUs: number): boolean {
  return startUs < toUs && (Number.isNaN(endUs) || endUs >= fromUs);
}

/**
 * Every sample of the session, and what the interface needs to show it.
 *
 * The session feeds it through {@link openEpoch}, {@link append}, {@link markDropped},
 * {@link markBoundary} and {@link setLatestValue}; it knows nothing about the link. Times are on
 * the session timeline, in microseconds: the session unwraps the robot's 32 bit clock and keeps
 * time moving forward across reboots, so that samples arrive in time order.
 *
 * Readers subscribe to variables and hear about changes at most once per scheduler tick.
 * {@link version}, {@link latest}, {@link history}, {@link boundaries} and {@link status} return
 * the same value until something changes, so they can back `useSyncExternalStore` directly; the
 * other queries compute a fresh answer on each call.
 */
export class TelemetryStore {
  private readonly blockSize: number;
  private readonly sequenceModulus: number;
  private readonly historyLength: number;
  private readonly variables = new Map<number, VariableRecord>();
  private readonly epochs = new Map<number, OpenEpoch>();
  private readonly openByGroup = new Map<number, Epoch>();
  private boundaryList: readonly Boundary[] = [];
  private readonly listeners = new Set<(event: TelemetryEvent) => void>();
  private readonly notifier: ChangeNotifier;
  private readonly residency: BlockResidency;
  private readonly statusChannel = new Channel();
  private statusSnapshot: StoreStatus;

  /**
   * @param options The scheduler, and the sizes and limits to use.
   */
  constructor(options: TelemetryStoreOptions) {
    this.blockSize = checkBlockSize(options.blockSize ?? DEFAULT_BLOCK_SIZE);
    this.sequenceModulus = options.sequenceModulus ?? 2 ** 16;
    this.historyLength = options.historyLength ?? 32;
    this.notifier = new ChangeNotifier(options.scheduler);
    this.residency = new BlockResidency({
      capBytes: options.memoryCapBytes ?? DEFAULT_MEMORY_CAP_BYTES,
      warningRatio: options.warningRatio ?? 0.8,
      emit: (event) => this.emit(event),
      statusChanged: () => this.refreshStatus(),
      reloaded: (block) => this.touchEpoch(block.ref.epochId),
    });
    this.statusSnapshot = this.residency.status();
  }

  /**
   * Start an epoch: a group layout the robot acknowledged. An epoch still open for the same group
   * closes.
   *
   * @throws If the epoch id was used before, a variable appears twice, or a variable is already
   *   in the open epoch of another group.
   */
  openEpoch(spec: EpochSpec): void {
    if (this.epochs.has(spec.epochId)) {
      throw new Error(`Epoch ${spec.epochId} was already opened`);
    }

    if (new Set(spec.variables.map((variable) => variable.id)).size !== spec.variables.length) {
      throw new Error(`Epoch ${spec.epochId} names a variable twice`);
    }

    for (const variable of spec.variables) {
      const current = this.variables.get(variable.id)?.segments.at(-1)?.epoch;

      if (current && !current.closed && current.groupId !== spec.groupId) {
        throw new Error(`Variable ${variable.id} is already streamed by epoch ${current.id}`);
      }
    }

    this.openByGroup.get(spec.groupId)?.close();
    const epoch = new Epoch(spec, this.blockSize, this.sequenceModulus, this.residency);
    const records = spec.variables.map((variable, index) => {
      const record = this.recordOf(variable.id);
      record.type = variable.type;
      record.segments.push({ epoch, column: epoch.columnOf[index] });
      this.notifier.touch(record.channel);
      return record;
    });

    this.epochs.set(spec.epochId, { epoch, records });
    this.openByGroup.set(spec.groupId, epoch);
    this.notifier.touch(this.statusChannel);
  }

  /**
   * Add a sample of an open epoch.
   *
   * @param epochId The epoch.
   * @param sequence The sample's sequence number; a jump marks dropped samples, and one behind the
   *   expected number, a duplicate, is ignored.
   * @param timeUs When the robot took it, on the session timeline; never before the previous one.
   * @param values One value per variable, in the epoch's order.
   * @throws If the epoch is not open, the number of values is wrong or time went backwards.
   */
  append(
    epochId: number,
    sequence: number,
    timeUs: number,
    values: ArrayLike<TelemetryValue>
  ): void {
    const { epoch, records } = this.openEpochOf(epochId);

    if (values.length !== records.length) {
      throw new RangeError(`Epoch ${epochId} takes ${records.length} values, got ${values.length}`);
    }

    if (epoch.receive(sequence, timeUs) < 0) {
      return;
    }

    epoch.store(timeUs, values);

    for (let index = 0; index < records.length; index++) {
      const record = records[index];
      const value = values[index];

      if (epoch.wide[index] && !record.precisionLost && losesPrecision(value)) {
        record.precisionLost = true;
        this.emit({ type: 'precision-loss', variableId: record.id });
      }

      record.update(value, timeUs, epoch.columnOf[index] < 0);
      this.notifier.touch(record.channel);
    }
  }

  /**
   * Note that samples of an open epoch were lost after the last one, when the session knows it
   * from something other than the sequence numbers.
   *
   * @throws If the epoch is not open.
   */
  markDropped(epochId: number, count: number): void {
    this.openEpochOf(epochId).epoch.markDropped(count);
    this.touchEpoch(epochId);
  }

  /**
   * Note that the link lost track of the robot. Every open epoch closes, and no line is drawn
   * across the moment.
   */
  markBoundary(kind: BoundaryKind, timeUs: number): void {
    this.boundaryList = [...this.boundaryList, { kind, timeUs }];

    for (const epoch of this.openByGroup.values()) {
      epoch.close();
      this.touchEpoch(epoch.id);
    }

    this.openByGroup.clear();
    this.notifier.touch(this.statusChannel);
  }

  /**
   * Record a value that did not come in a stream sample, such as a READ answer or a blob.
   *
   * @param variableId The variable.
   * @param value The value as decoded.
   * @param timeUs When it was sampled, if known.
   */
  setLatestValue(variableId: number, value: TelemetryValue, timeUs?: number): void {
    const record = this.recordOf(variableId);
    record.update(value, timeUs, !record.numeric);
    this.notifier.touch(record.channel);
  }

  /**
   * The latest value of a variable; the same object until it changes.
   */
  latest(variableId: number): LatestValue | undefined {
    return this.variables.get(variableId)?.latest;
  }

  /**
   * The last values of a variable that is not stored numerically, such as a blob, oldest first;
   * the same array until a value arrives.
   */
  history(variableId: number): readonly LatestValue[] {
    return this.variables.get(variableId)?.history ?? NO_VALUES;
  }

  /**
   * What the store knows about a variable.
   */
  variable(variableId: number): VariableInfo | undefined {
    const record = this.variables.get(variableId);

    if (!record) {
      return undefined;
    }

    let storedSamples = 0;
    let droppedSamples = 0;

    for (const { epoch } of record.segments) {
      storedSamples += epoch.storedCount;
      droppedSamples += epoch.droppedCount;
    }

    return {
      id: record.id,
      type: record.type,
      storage: record.type === undefined ? undefined : (columnKindOf(record.type) ?? 'none'),
      precisionLost: record.precisionLost,
      storedSamples,
      droppedSamples,
      epochs: record.segments.length,
    };
  }

  /**
   * The span of the stored history, of one variable or of the whole session.
   */
  timeRange(variableId?: number): TimeRange | undefined {
    const epochs =
      variableId === undefined
        ? [...this.epochs.values()].map(({ epoch }) => epoch)
        : (this.variables.get(variableId)?.segments ?? [])
            .filter((segment) => segment.column >= 0)
            .map((segment) => segment.epoch);
    let startUs = Number.POSITIVE_INFINITY;
    let endUs = Number.NEGATIVE_INFINITY;

    for (const epoch of epochs) {
      if (epoch.storedCount > 0) {
        startUs = Math.min(startUs, epoch.firstTimeUs);
        endUs = Math.max(endUs, epoch.lastTimeUs);
      }
    }

    return startUs <= endUs ? { startUs, endUs } : undefined;
  }

  /**
   * The stored samples of a variable in `[startUs, endUs)`, as views into the store's blocks.
   *
   * Blocks evicted to the persistence layer are skipped and asked back; the variable's version
   * changes when they return.
   */
  *samples(variableId: number, startUs: number, endUs: number): Generator<SampleRun> {
    const record = this.variables.get(variableId);

    if (!record) {
      return;
    }

    this.residency.beginQuery();

    for (const { epoch, column } of record.segments) {
      if (column < 0) {
        continue;
      }

      for (const block of epoch.blocks) {
        if (block.length === 0 || block.lastTimeUs < startUs) {
          continue;
        }

        if (block.firstTimeUs >= endUs) {
          break;
        }

        const run = this.runOf(block, column, startUs, endUs);

        if (run) {
          yield { epochId: epoch.id, ...run };
        }
      }
    }
  }

  /**
   * The minimum and maximum of a variable per pixel column of `[startUs, endUs)`, with where its
   * line breaks: between epochs, at dropped samples, at boundaries and at NaN. Lay the result out
   * for uPlot with `toLineSeries` or `toBandSeries`.
   *
   * The cost follows the number of pixels and pyramid levels, not the number of samples.
   *
   * @param variableId The variable.
   * @param startUs The start of the window, inclusive.
   * @param endUs The end of the window, exclusive.
   * @param pixels How many columns to split it into.
   * @param options A decimation to reuse and counters to fill.
   */
  decimate(
    variableId: number,
    startUs: number,
    endUs: number,
    pixels: number,
    options: DecimateOptions = {}
  ): Decimation {
    const into = options.into ?? new Decimation();
    into.reset(startUs, endUs, pixels);
    const record = this.variables.get(variableId);

    if (record) {
      this.residency.beginQuery();
      decimateSegments(into, record.segments, this.boundaryList, this.residency, options.stats);
    }

    return into;
  }

  /**
   * Why a variable has no samples in parts of `[startUs, endUs)`: time between its epochs,
   * dropped samples and samples not kept, ordered by start.
   */
  gaps(variableId: number, startUs: number, endUs: number): Gap[] {
    const found: Gap[] = [];
    let coveredUntil = Number.NaN;

    for (const { epoch, column } of this.variables.get(variableId)?.segments ?? []) {
      if (column < 0 || epoch.storedCount === 0) {
        continue;
      }

      if (
        epoch.firstTimeUs > coveredUntil &&
        overlaps(coveredUntil, epoch.firstTimeUs, startUs, endUs)
      ) {
        found.push({ kind: 'not-streamed', startUs: coveredUntil, endUs: epoch.firstTimeUs });
      }

      coveredUntil = Number.isNaN(coveredUntil)
        ? epoch.lastTimeUs
        : Math.max(coveredUntil, epoch.lastTimeUs);

      for (const gap of epoch.gaps) {
        const gapStart = Number.isNaN(gap.afterUs) ? gap.untilUs : gap.afterUs;

        if (overlaps(gapStart, gap.untilUs, startUs, endUs)) {
          found.push({ kind: gap.kind, startUs: gapStart, endUs: gap.untilUs, count: gap.count });
        }
      }

      if (epoch.unstoredRun > 0 && overlaps(epoch.lastTimeUs, Number.NaN, startUs, endUs)) {
        found.push({
          kind: 'not-stored',
          startUs: epoch.lastTimeUs,
          endUs: Number.NaN,
          count: epoch.unstoredRun,
        });
      }
    }

    return found.toSorted((left, right) => left.startUs - right.startUs);
  }

  /**
   * Every boundary so far, oldest first; the same array until a boundary is added.
   */
  boundaries(): readonly Boundary[] {
    return this.boundaryList;
  }

  /**
   * A number that changes whenever anything a reader can see of a variable changes; the snapshot
   * for `useSyncExternalStore`.
   */
  version(variableId: number): number {
    return this.variables.get(variableId)?.channel.version ?? 0;
  }

  /**
   * Hear about changes to some variables, at most once per scheduler tick.
   *
   * @returns A function that ends the subscription.
   */
  subscribe(variableIds: readonly number[], callback: () => void): () => void {
    const channels = variableIds.map((id) => this.recordOf(id).channel);
    return this.notifier.subscribe(channels, callback);
  }

  /**
   * Hear about changes to the status, the epochs and the boundaries, at most once per tick.
   *
   * @returns A function that ends the subscription.
   */
  subscribeStatus(callback: () => void): () => void {
    return this.notifier.subscribe([this.statusChannel], callback);
  }

  /**
   * The memory used and the recording state; the same object until it changes.
   */
  status(): StoreStatus {
    return this.statusSnapshot;
  }

  /**
   * Hear about warnings as they happen: memory, precision and persistence.
   *
   * @returns A function that stops listening.
   */
  onEvent(listener: (event: TelemetryEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Start writing sealed blocks to a persistence layer, those already sealed included, so that
   * they may leave memory under the cap and come back when a query needs them.
   */
  startRecording(persistence: BlockPersistence): void {
    this.residency.startRecording(persistence);
  }

  /**
   * Stop writing blocks. Blocks already written can still leave memory and come back.
   */
  stopRecording(): void {
    this.residency.stopRecording();
  }

  private recordOf(variableId: number): VariableRecord {
    let record = this.variables.get(variableId);

    if (!record) {
      record = new VariableRecord(variableId, this.historyLength);
      this.variables.set(variableId, record);
    }

    return record;
  }

  private openEpochOf(epochId: number): OpenEpoch {
    const open = this.epochs.get(epochId);

    if (!open) {
      throw new Error(`No epoch ${epochId}`);
    }

    if (open.epoch.closed) {
      throw new Error(`Epoch ${epochId} is closed`);
    }

    return open;
  }

  private runOf(
    block: Block,
    column: number,
    startUs: number,
    endUs: number
  ): Omit<SampleRun, 'epochId'> | undefined {
    const time = block.time;
    const columns = block.columns;

    if (!this.residency.touch(block) || !time || !columns) {
      this.residency.request(block);
      return undefined;
    }

    const first = lowerBound(time, startUs, 0, block.length);
    const end = lowerBound(time, endUs, first, block.length);

    if (first >= end) {
      return undefined;
    }

    return { time: time.subarray(first, end), values: columns[column].subarray(first, end) };
  }

  private touchEpoch(epochId: number): void {
    for (const record of this.epochs.get(epochId)?.records ?? []) {
      this.notifier.touch(record.channel);
    }
  }

  private refreshStatus(): void {
    this.statusSnapshot = this.residency.status();
    this.notifier.touch(this.statusChannel);
  }

  private emit(event: TelemetryEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}
