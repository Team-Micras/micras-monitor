import type { TypeCode } from '@/protocol';

import type { Block } from './block';
import { ChannelRegistry } from './channels';
import {
  type Decimation,
  DecimationBuilder,
  decimateSegments,
  type DecimationStats,
  lowerBound,
  upperBound,
} from './decimation';
import { Epoch, type EpochHost, RECEIVED_BACKWARDS } from './epoch';
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
  HistoryMark,
  IngestionEvent,
  LatestValue,
  SampleRun,
  SampleValue,
  SchemaEntry,
  StoreStatus,
  TelemetryEvent,
  TelemetryValue,
  TimeRange,
  VariableRef,
} from './types';
import type { VariableRecord } from './variable';
import { nextUp } from './window';

/** How many samples a block holds at most unless told otherwise. */
export const DEFAULT_BLOCK_SIZE = 65_536;

/** The memory cap unless told otherwise: 256 MiB. */
export const DEFAULT_MEMORY_CAP_BYTES = 256 * 1024 * 1024;

/** How often, while recording, the blocks being filled are written unless told otherwise. */
export const DEFAULT_FLUSH_INTERVAL_MS = 5000;

/**
 * How to set up a store.
 */
export interface TelemetryStoreOptions {
  /** When subscribers hear about changes and query ticks end: `requestAnimationFrame` in the app. */
  readonly scheduler: Scheduler;

  /**
   * How many samples a block holds at most: a power of two, at least 16. An epoch's first blocks
   * are smaller, from 1,024 samples up, so that short epochs take little memory.
   */
  readonly blockSize?: number;

  /** The most memory blocks and gap records may take. */
  readonly memoryCapBytes?: number;

  /** The share of the cap at which to warn; 0.8 by default. */
  readonly warningRatio?: number;

  /** Where the robot's sequence numbers wrap; 2¹⁶, a `u16` on the wire, by default. */
  readonly sequenceModulus?: number;

  /** How many values to keep for variables not stored numerically, such as blobs; 32. */
  readonly historyLength?: number;

  /** Wall time in milliseconds; `Date.now` by default. */
  readonly now?: () => number;

  /** How often, while recording, the blocks being filled are sealed and written; 5 s. */
  readonly flushIntervalMs?: number;

  /** How many evicted blocks may be read back at once; 4. */
  readonly maxConcurrentLoads?: number;
}

/**
 * What the store knows about a variable.
 */
export interface VariableInfo {
  /** Its name. */
  readonly name: string;

  /** Its type, once known. */
  readonly type: TypeCode | undefined;

  /** How its history is stored, or `none` for blobs. */
  readonly storage: ColumnKind | 'none' | undefined;

  /** Whether a 64 bit integer it held did not fit a float exactly. */
  readonly precisionLost: boolean;

  /** How many of its samples are kept. */
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
  /**
   * A previous result to reuse. Asked again for the same variable and grid, only the columns
   * from the previous last sample on are recomputed, unless the history changed further back.
   */
  readonly into?: Decimation;

  /** Add what the query read to these counters. */
  readonly stats?: DecimationStats;
}

interface OpenEpoch {
  readonly epoch: Epoch;
  readonly records: readonly VariableRecord[];
}

interface Cached<T> {
  readonly version: number;
  readonly value: T;
}

const NO_VALUES: readonly LatestValue[] = [];

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
 * The session feeds it: {@link setSchema} after each handshake, {@link openEpoch} when a
 * GROUP_ACK arrives, {@link closeEpoch} when a group is disabled or redefined, {@link append} for
 * every sample, {@link markBoundary} when the link loses the robot, and {@link setLatestValue} for
 * READ answers. It knows nothing about the link. Times are on the session timeline, in
 * microseconds: the session unwraps the robot's 32 bit clock and keeps time moving forward across
 * reboots.
 *
 * History is kept per variable name and type, so that it survives a schema change; queries take
 * a name, or an id of the current schema. Readers subscribe and hear about changes at most once
 * per scheduler tick. {@link version}, {@link latest}, {@link history}, {@link variable},
 * {@link timeRange}, {@link historyMark}, {@link boundaries} and {@link status} return the same
 * value until something changes, so they can back `useSyncExternalStore` directly.
 */
export class TelemetryStore {
  private readonly blockSize: number;
  private readonly sequenceModulus: number;
  private readonly registry: ChannelRegistry;
  private readonly epochs = new Map<number, OpenEpoch>();
  private readonly openByGroup = new Map<number, Epoch>();
  private boundaryList: readonly Boundary[] = [];
  private readonly listeners = new Set<(event: TelemetryEvent) => void>();
  private readonly ingestionListeners = new Set<(event: IngestionEvent) => void>();
  private readonly notifier: ChangeNotifier;
  private readonly residency: BlockResidency;
  private readonly host: EpochHost;
  private readonly statusChannel = new Channel();
  private readonly infoCache = new WeakMap<VariableRecord, Cached<VariableInfo>>();
  private readonly rangeCache = new WeakMap<VariableRecord, Cached<TimeRange | undefined>>();
  private readonly lastIds = new WeakMap<VariableRecord, number>();
  private sessionRange: Cached<TimeRange | undefined> | undefined;
  private statusSnapshot: StoreStatus;
  private historyVersion = 0;
  private clockUs = Number.NEGATIVE_INFINITY;

  /**
   * @param options The scheduler, and the sizes and limits to use.
   */
  constructor(options: TelemetryStoreOptions) {
    this.blockSize = checkBlockSize(options.blockSize ?? DEFAULT_BLOCK_SIZE);
    this.sequenceModulus = options.sequenceModulus ?? 2 ** 16;
    this.registry = new ChannelRegistry(options.historyLength ?? 32);
    this.notifier = new ChangeNotifier(options.scheduler);
    this.residency = new BlockResidency({
      capBytes: options.memoryCapBytes ?? DEFAULT_MEMORY_CAP_BYTES,
      warningRatio: options.warningRatio ?? 0.8,
      scheduler: options.scheduler,
      now: options.now ?? Date.now,
      flushIntervalMs: options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS,
      maxConcurrentLoads: options.maxConcurrentLoads ?? 4,
      emit: (event) => this.emit(event),
      statusChanged: () => this.refreshStatus(),
      sealOpenBlocks: () => {
        for (const epoch of this.openByGroup.values()) {
          epoch.sealOpenBlock();
        }
      },
      reloaded: (block) => this.rewriteEpoch(block.ref.epochId),
      evicted: (block) => this.rewriteEpoch(block.ref.epochId),
      dropped: (block) => this.dropBlock(block),
    });
    this.host = {
      allocate: (layout) => this.residency.allocate(layout),
      seal: (block) => this.residency.seal(block),
      account: (bytes) => this.residency.account(bytes),
      gapFinal: (epoch, gap) => this.ingest({ type: 'gap', gap: epoch.recordedGap(gap) }),
    };
    this.statusSnapshot = this.residency.status();
  }

  /**
   * Take the robot's schema, which maps its ids to names. A name that comes back with another
   * type starts a new history, and a boundary marks the change.
   *
   * @param entries Every variable of the schema.
   * @param timeUs When the schema took effect; the latest sample's time by default.
   */
  setSchema(entries: readonly SchemaEntry[], timeUs = this.clockUs): void {
    if (this.registry.setSchema(entries) && Number.isFinite(timeUs)) {
      this.addBoundary('schema', timeUs);
    }

    this.notifier.touch(this.statusChannel);
  }

  /**
   * Start an epoch: a group layout the robot acknowledged. Any open epoch it conflicts with, of
   * the same group or sharing a variable, closes first, so the order acknowledgements arrive in
   * does not matter.
   *
   * @throws If the epoch id was used before or a variable appears twice.
   */
  openEpoch(spec: EpochSpec): void {
    if (this.epochs.has(spec.epochId)) {
      throw new Error(`Epoch ${spec.epochId} was already opened`);
    }

    if (new Set(spec.variables.map((variable) => variable.id)).size !== spec.variables.length) {
      throw new Error(`Epoch ${spec.epochId} names a variable twice`);
    }

    const variables = spec.variables.map((variable) => ({
      id: variable.id,
      name: variable.name ?? this.registry.nameOf(variable.id),
      type: variable.type,
    }));
    let typeChanged = false;
    const records = variables.map(({ id, name, type }) => {
      const before = this.registry.resolve(name);
      const record = this.registry.recordFor(name, type);
      typeChanged ||= before !== undefined && before !== record;
      this.lastIds.set(record, id);
      return record;
    });

    if (typeChanged && Number.isFinite(this.clockUs)) {
      this.addBoundary('schema', this.clockUs);
    }

    for (const open of this.epochs.values()) {
      const conflicts =
        open.epoch.groupId === spec.groupId ||
        open.records.some((record) => records.includes(record));

      if (!open.epoch.closed && conflicts) {
        this.closeEpoch(open.epoch.id);
      }
    }

    const epoch = new Epoch(
      {
        epochId: spec.epochId,
        groupId: spec.groupId,
        variables,
        firstSequence: spec.firstSequence,
      },
      this.blockSize,
      this.sequenceModulus,
      this.host
    );

    records.forEach((record, index) => {
      record.segments.push({ epoch, column: epoch.columnOf[index] });
      record.appended();
      this.notifier.touch(record.channel);
    });

    this.epochs.set(spec.epochId, { epoch, records });
    this.openByGroup.set(spec.groupId, epoch);
    this.ingest({ type: 'epoch-opened', epoch: epoch.recorded });
    this.notifier.touch(this.statusChannel);
  }

  /**
   * Close an epoch: its group was disabled or redefined. Closing a closed epoch does nothing.
   *
   * @throws If no epoch has that id.
   */
  closeEpoch(epochId: number): void {
    const open = this.epochs.get(epochId);

    if (!open) {
      throw new Error(`No epoch ${epochId}`);
    }

    if (open.epoch.closed) {
      return;
    }

    open.epoch.close();

    if (this.openByGroup.get(open.epoch.groupId) === open.epoch) {
      this.openByGroup.delete(open.epoch.groupId);
    }

    for (const record of open.records) {
      record.appended();
      this.notifier.touch(record.channel);
    }

    this.ingest({ type: 'epoch-closed', epochId });
    this.notifier.touch(this.statusChannel);
  }

  /**
   * Add a sample of an open epoch. The latest values always take it; the history leaves out a
   * sample whose time repeats the previous one's, a duplicate, and one whose time goes back,
   * which also raises a `time-backwards` event.
   *
   * @param epochId The epoch.
   * @param sequence The sample's sequence number; a jump marks dropped samples.
   * @param timeUs When the robot took it, on the session timeline.
   * @param values One value per variable, in the epoch's order.
   * @throws If the epoch is not open or the number of values is wrong.
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

    const received = epoch.receive(sequence, timeUs);

    if (received === RECEIVED_BACKWARDS) {
      this.emit({ type: 'time-backwards', epochId, timeUs, lastUs: epoch.lastTimeUs });
    }

    const kept = received >= 0;
    const stored = kept && epoch.store(timeUs, values);

    if (kept) {
      this.clockUs = Math.max(this.clockUs, timeUs);
      this.historyVersion++;
    }

    for (let index = 0; index < records.length; index++) {
      const record = records[index];
      const value = values[index];
      record.setLatest(value, timeUs);

      if (epoch.columnOf[index] < 0) {
        record.remember(value, timeUs);
        this.ingestValue(record, epoch.variables[index].id, value, timeUs);
      } else if (kept) {
        this.checkPrecision(record, epoch.wide[index], value);

        if (stored) {
          record.tailUs = timeUs;
          record.appended();
        }
      }

      this.notifier.touch(record.channel);
    }

    this.residency.flushIfDue();
  }

  /**
   * Note that the link lost track of the robot. Every open epoch closes, and no line is drawn
   * across the moment.
   */
  markBoundary(kind: BoundaryKind, timeUs: number): void {
    this.addBoundary(kind, timeUs);

    for (const epoch of this.openByGroup.values()) {
      this.closeEpoch(epoch.id);
    }
  }

  /**
   * Record a value that did not come in a stream sample, such as a READ answer or a blob.
   *
   * @param variableId The variable, in the current schema.
   * @param value The value as decoded.
   * @param timeUs When it was sampled, if known.
   */
  setLatestValue(variableId: number, value: TelemetryValue, timeUs?: number): void {
    const record = this.registry.recordFor(
      this.registry.nameOf(variableId),
      this.registry.typeOf(variableId)
    );
    this.lastIds.set(record, variableId);
    record.setLatest(value, timeUs);

    if (!record.numeric) {
      record.remember(value, timeUs);
    }

    this.ingestValue(record, variableId, value, timeUs ?? Number.NaN);
    this.notifier.touch(record.channel);
  }

  /**
   * Forget the history and stop recording, keeping the schema, the latest values and the open
   * epochs, which carry on from nothing. A persistence layer written before is no longer read.
   */
  reset(): void {
    for (const { epoch } of this.epochs.values()) {
      if (!epoch.closed) {
        epoch.clearHistory();
      }
    }

    this.residency.reset();

    for (const [epochId, { epoch }] of this.epochs) {
      if (epoch.closed) {
        this.epochs.delete(epochId);
      }
    }

    for (const record of this.registry.all()) {
      const open = record.segments.filter((segment) => !segment.epoch.closed);
      record.segments.length = 0;
      record.segments.push(...open);
      record.tailUs = Number.NEGATIVE_INFINITY;
      record.rewritten();
      this.notifier.touch(record.channel);
    }

    this.boundaryList = [];
    this.historyVersion++;
    this.refreshStatus();
  }

  /** The latest value of a variable; the same object until it changes. */
  latest(variable: VariableRef): LatestValue | undefined {
    return this.registry.resolve(variable)?.latest;
  }

  /**
   * The last values of a variable that is not stored numerically, such as a blob, oldest first;
   * the same array until a value arrives.
   */
  history(variable: VariableRef): readonly LatestValue[] {
    return this.registry.resolve(variable)?.history ?? NO_VALUES;
  }

  /** What the store knows about a variable; the same object until it changes. */
  variable(variable: VariableRef): VariableInfo | undefined {
    const record = this.registry.resolve(variable);

    if (!record) {
      return undefined;
    }

    const version = 2 * record.mark.version + (record.precisionLost ? 1 : 0);
    const cached = this.infoCache.get(record);

    if (cached?.version === version && cached.value.type === record.type) {
      return cached.value;
    }

    let storedSamples = 0;
    let droppedSamples = 0;

    for (const { epoch } of record.segments) {
      storedSamples += epoch.keptCount;
      droppedSamples += epoch.droppedCount;
    }

    const value: VariableInfo = {
      name: record.name,
      type: record.type,
      storage: record.type === undefined ? undefined : (columnKindOf(record.type) ?? 'none'),
      precisionLost: record.precisionLost,
      storedSamples,
      droppedSamples,
      epochs: record.segments.length,
    };
    this.infoCache.set(record, { version, value });
    return value;
  }

  /**
   * The span of the kept history, of one variable or of the whole session, as a half-open range
   * that holds the last sample; the same object until it changes.
   */
  timeRange(variable?: VariableRef): TimeRange | undefined {
    if (variable === undefined) {
      if (this.sessionRange?.version !== this.historyVersion) {
        const epochs = [...this.epochs.values()].map(({ epoch }) => epoch);
        this.sessionRange = { version: this.historyVersion, value: this.rangeOf(epochs) };
      }

      return this.sessionRange.value;
    }

    const record = this.registry.resolve(variable);

    if (!record) {
      return undefined;
    }

    const cached = this.rangeCache.get(record);

    if (cached?.version === record.mark.version) {
      return cached.value;
    }

    const epochs = record.segments.filter((segment) => segment.column >= 0).map((s) => s.epoch);
    const value = this.rangeOf(epochs);
    this.rangeCache.set(record, { version: record.mark.version, value });
    return value;
  }

  /**
   * Where a variable's history stands, to ask {@link changedSince} later; the same object until
   * it changes.
   */
  historyMark(variable: VariableRef): HistoryMark | undefined {
    return this.registry.resolve(variable)?.mark;
  }

  /**
   * Whether a window of a variable's history may look different than when the mark was taken,
   * so that a paused plot redraws only when it has to: appends at the live end do not touch a
   * window that ends before them.
   */
  changedSince(variable: VariableRef, mark: HistoryMark | undefined, window: TimeRange): boolean {
    const current = this.historyMark(variable);

    if (!current || !mark) {
      return current !== mark;
    }

    if (current.source !== mark.source || current.rewrite !== mark.rewrite) {
      return true;
    }

    return current.version !== mark.version && window.endUs > mark.tailUs;
  }

  /**
   * The stored samples of a variable in `[startUs, endUs)`, as views into the store's blocks.
   *
   * Blocks evicted to the persistence layer are skipped and asked back; the variable's version
   * changes when they return.
   */
  *samples(variable: VariableRef, startUs: number, endUs: number): Generator<SampleRun> {
    const record = this.registry.resolve(variable);

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
   * The stored sample of a variable at a time, or the last one before it, for cursors synced
   * across plots. Undefined before the first sample, or while its block is being read back.
   */
  valueAt(variable: VariableRef, timeUs: number): SampleValue | undefined {
    const segments = this.registry.resolve(variable)?.segments ?? [];
    this.residency.beginQuery();

    for (let index = segments.length - 1; index >= 0; index--) {
      const { epoch, column } = segments[index];
      const block = epoch.blocks.findLast(
        (candidate) => candidate.length > 0 && candidate.firstTimeUs <= timeUs
      );

      if (column < 0 || !block) {
        continue;
      }

      this.residency.markUsed(block);
      const time = block.time;
      const columns = block.columns;

      if (!time || !columns) {
        this.residency.request(block);
        return undefined;
      }

      const at = upperBound(time, timeUs, 0, block.length) - 1;
      return { value: columns[column][at], timeUs: time[at] };
    }

    return undefined;
  }

  /**
   * The minimum and maximum of a variable per pixel column of `[startUs, endUs)`, with where its
   * line breaks: between epochs, at dropped samples, at boundaries and after NaN. Lay the result
   * out for uPlot with `toLineSeries` or `toBandSeries`.
   *
   * The cost follows the number of pixels and pyramid levels, not the number of samples; asked
   * again with the previous result, over the same grid, only the trailing columns are redone.
   *
   * @param variable The variable.
   * @param startUs The start of the window, inclusive.
   * @param endUs The end of the window, exclusive.
   * @param pixels How many columns to split it into.
   * @param options A result to reuse and counters to fill.
   */
  decimate(
    variable: VariableRef,
    startUs: number,
    endUs: number,
    pixels: number,
    options: DecimateOptions = {}
  ): Decimation {
    const into = options.into instanceof DecimationBuilder ? options.into : new DecimationBuilder();
    const record = this.registry.resolve(variable);

    if (!record) {
      into.reset(startUs, endUs, pixels);
      return into;
    }

    const mark = record.mark;
    const previous = into.mark;
    const reusable =
      into.source === record &&
      previous !== undefined &&
      previous.rewrite === mark.rewrite &&
      into.sameGrid(startUs, endUs, pixels);

    if (reusable && previous.version === mark.version) {
      return into;
    }

    if (reusable) {
      into.resetFrom(into.columnOf(previous.tailUs));
    } else {
      into.reset(startUs, endUs, pixels);
    }

    this.residency.beginQuery();
    decimateSegments(into, record.segments, this.boundaryList, this.residency, options.stats);
    into.source = record;
    into.mark = mark;
    return into;
  }

  /**
   * Why a variable has no samples in parts of `[startUs, endUs)`: time between its epochs,
   * dropped samples and samples not kept, ordered by start.
   */
  gaps(variable: VariableRef, startUs: number, endUs: number): Gap[] {
    const found: Gap[] = [];
    let coveredUntil = Number.NaN;

    for (const { epoch, column } of this.registry.resolve(variable)?.segments ?? []) {
      if (column < 0) {
        continue;
      }

      if (epoch.storedCount > 0) {
        if (
          epoch.firstStoredUs > coveredUntil &&
          overlaps(coveredUntil, epoch.firstStoredUs, startUs, endUs)
        ) {
          found.push({ kind: 'not-streamed', startUs: coveredUntil, endUs: epoch.firstStoredUs });
        }

        coveredUntil = Number.isNaN(coveredUntil)
          ? epoch.lastTimeUs
          : Math.max(coveredUntil, epoch.lastTimeUs);
      }

      for (const gap of epoch.gaps) {
        const gapStart = Number.isNaN(gap.startUs) ? gap.untilUs : gap.startUs;

        if (overlaps(gapStart, gap.untilUs, startUs, endUs)) {
          found.push({ kind: gap.kind, startUs: gapStart, endUs: gap.untilUs, count: gap.count });
        }
      }

      if (epoch.unstoredRun > 0 && overlaps(epoch.unstoredFrom, Number.NaN, startUs, endUs)) {
        found.push({
          kind: 'not-stored',
          startUs: epoch.unstoredFrom,
          endUs: Number.NaN,
          count: epoch.unstoredRun,
        });
      }
    }

    return found.toSorted((left, right) => left.startUs - right.startUs);
  }

  /** Every boundary so far, oldest first; the same array until a boundary is added. */
  boundaries(): readonly Boundary[] {
    return this.boundaryList;
  }

  /**
   * A number that changes whenever anything a reader can see of a variable changes; the snapshot
   * for `useSyncExternalStore`.
   */
  version(variable: VariableRef): number {
    return this.registry.channelFor(variable).version;
  }

  /**
   * Hear about changes to some variables, at most once per scheduler tick. A name keeps being
   * followed across schema changes; an id is taken as the name it has now.
   *
   * @returns A function that ends the subscription.
   */
  subscribe(variables: readonly VariableRef[], callback: () => void): () => void {
    const channels = variables.map((variable) => this.registry.channelFor(variable));
    return this.notifier.subscribe(channels, callback);
  }

  /**
   * Hear about changes to the status, the schema, the epochs and the boundaries, at most once
   * per tick.
   *
   * @returns A function that ends the subscription.
   */
  subscribeStatus(callback: () => void): () => void {
    return this.notifier.subscribe([this.statusChannel], callback);
  }

  /** The memory used and the recording state; the same object until it changes. */
  status(): StoreStatus {
    return this.statusSnapshot;
  }

  /**
   * Hear about warnings as they happen: memory, precision, time and persistence.
   *
   * @returns A function that stops listening.
   */
  onEvent(listener: (event: TelemetryEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Hear, as they happen, about what a recorder writes besides the blocks: epochs opening and
   * closing, gaps once final, boundaries, and values outside the stored streams.
   *
   * @returns A function that stops listening.
   */
  onIngestion(listener: (event: IngestionEvent) => void): () => void {
    this.ingestionListeners.add(listener);
    return () => this.ingestionListeners.delete(listener);
  }

  /**
   * Tell a listener, at once, what {@link onIngestion} would have told it about the session so
   * far, for a recorder that starts late: every epoch and its final gaps, the boundaries, and the
   * latest value of each variable not stored numerically.
   */
  replayIngestion(listener: (event: IngestionEvent) => void): void {
    for (const { epoch } of this.epochs.values()) {
      listener({ type: 'epoch-opened', epoch: epoch.recorded });

      for (const gap of epoch.gaps) {
        if (epoch.closed || !Number.isNaN(gap.untilUs)) {
          listener({ type: 'gap', gap: epoch.recordedGap(gap) });
        }
      }

      if (epoch.closed) {
        listener({ type: 'epoch-closed', epochId: epoch.id });
      }
    }

    for (const boundary of this.boundaryList) {
      listener({ type: 'boundary', boundary });
    }

    for (const record of this.registry.all()) {
      const latest = record.latest;
      const variableId = this.lastIds.get(record);

      if (latest && !record.numeric && variableId !== undefined) {
        listener({
          type: 'value',
          value: {
            variableId,
            name: record.name,
            timeUs: latest.timeUs ?? Number.NaN,
            value: latest.value,
          },
        });
      }
    }
  }

  /**
   * Start writing blocks to a persistence layer: the whole session so far first, then every
   * block as it seals, and the blocks being filled every few seconds. Blocks written may leave
   * memory under the cap and come back when a query needs them. The records besides the blocks
   * come from {@link replayIngestion}, then {@link onIngestion}.
   */
  startRecording(persistence: BlockPersistence): void {
    this.residency.startRecording(persistence);
  }

  /**
   * Write what is being filled, then stop writing blocks. Blocks already written can still leave
   * memory and come back.
   *
   * @returns A promise that settles once every write under way has.
   */
  stopRecording(): Promise<void> {
    return this.residency.stopRecording();
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

  private checkPrecision(record: VariableRecord, wide: boolean, value: TelemetryValue): void {
    if (wide && !record.precisionLost && losesPrecision(value)) {
      record.precisionLost = true;
      this.emit({ type: 'precision-loss', name: record.name });
    }
  }

  private addBoundary(kind: BoundaryKind, timeUs: number): void {
    const boundary = { kind, timeUs };
    this.boundaryList = [...this.boundaryList, boundary];
    this.historyVersion++;

    for (const record of this.registry.all()) {
      if (timeUs < record.tailUs) {
        record.rewritten();
      } else {
        record.appended();
      }

      this.notifier.touch(record.channel);
    }

    this.ingest({ type: 'boundary', boundary });
    this.notifier.touch(this.statusChannel);
  }

  private rangeOf(epochs: readonly Epoch[]): TimeRange | undefined {
    let startUs = Number.POSITIVE_INFINITY;
    let lastUs = Number.NEGATIVE_INFINITY;

    for (const epoch of epochs) {
      if (epoch.keptCount > 0) {
        startUs = Math.min(startUs, epoch.firstTimeUs);
        lastUs = Math.max(lastUs, epoch.lastTimeUs);
      }
    }

    return startUs <= lastUs ? { startUs, endUs: nextUp(lastUs) } : undefined;
  }

  private runOf(
    block: Block,
    column: number,
    startUs: number,
    endUs: number
  ): Omit<SampleRun, 'epochId'> | undefined {
    this.residency.markUsed(block);
    const time = block.time;
    const columns = block.columns;

    if (!time || !columns) {
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

  private dropBlock(block: Block): void {
    this.epochs.get(block.ref.epochId)?.epoch.dropBlock(block);
    this.historyVersion++;
    this.rewriteEpoch(block.ref.epochId);
  }

  private rewriteEpoch(epochId: number): void {
    for (const record of this.epochs.get(epochId)?.records ?? []) {
      record.rewritten();
      this.notifier.touch(record.channel);
    }
  }

  private ingestValue(
    record: VariableRecord,
    variableId: number,
    value: TelemetryValue,
    timeUs: number
  ): void {
    if (this.ingestionListeners.size > 0) {
      this.ingest({ type: 'value', value: { variableId, name: record.name, timeUs, value } });
    }
  }

  private ingest(event: IngestionEvent): void {
    for (const listener of this.ingestionListeners) {
      listener(event);
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
