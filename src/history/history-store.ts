import type { Value, ValueType } from '@/core/variables';

import type { Block } from './block';
import type { BlockBacking, BlockData, StoredRecording } from './block-backing';
import { type ColumnKind, columnKindOf, losesPrecision } from './columns';
import {
  type Decimation,
  DecimationBuilder,
  decimateSegments,
  type DecimationStats,
  firstBlockFrom,
  lowerBound,
  upperBound,
} from './decimation';
import { BlockMemory } from './memory/block-memory';
import { LEAF_SIZE } from './min-max-pyramid';
import type { Scheduler } from './scheduler';
import { StreamRun, type StreamRunHost, RECEIVED_BACKWARDS } from './stream-run';
import { TickNotifier, ChangeSignal } from './tick-notifier';
import type {
  Boundary,
  BoundaryKind,
  StreamRunSpec,
  Gap,
  HistoryMark,
  IngestionEvent,
  LatestValue,
  RecordedRun,
  SampleRun,
  SampleValue,
  HistoryVariable,
  StoreStatus,
  StoreWarning,
  TimeRange,
  VariableRef,
} from './types';
import type { VariableHistory } from './variable-history';
import { VariableRegistry } from './variable-registry';
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
export interface HistoryStoreOptions {
  /** When subscribers hear about changes and query ticks end: `requestAnimationFrame` in the app. */
  readonly scheduler: Scheduler;

  /**
   * How many samples a block holds at most: a power of two, at least 16. A run's first blocks
   * are smaller, from 1,024 samples up, so that short runs take little memory.
   */
  readonly blockSize?: number;

  /** The most memory blocks and gap records may take. */
  readonly memoryCapBytes?: number;

  /** The share of the cap at which to warn; 0.8 by default. */
  readonly warningRatio?: number;

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
  readonly type: ValueType | undefined;

  /** How its history is stored, or `none` for blobs. */
  readonly storage: ColumnKind | 'none' | undefined;

  /** Whether a 64 bit integer it held did not fit a float exactly. */
  readonly precisionLost: boolean;

  /** How many of its samples are kept. */
  readonly storedSamples: number;

  /** How many of its samples the source lost. */
  readonly droppedSamples: number;

  /** How many runs it was part of. */
  readonly runs: number;
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

interface OpenRun {
  readonly run: StreamRun;
  readonly records: readonly VariableHistory[];
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

function blockAt(blocks: readonly Block[], timeUs: number): Block | undefined {
  for (let at = Math.min(firstBlockFrom(blocks, timeUs), blocks.length - 1); at >= 0; at--) {
    const block = blocks[at];

    if (block.length > 0 && block.firstTimeUs <= timeUs) {
      return block;
    }
  }

  return undefined;
}

function overlaps(startUs: number, endUs: number, fromUs: number, toUs: number): boolean {
  return startUs < toUs && (Number.isNaN(endUs) || endUs >= fromUs);
}

/**
 * Every sample of the session, and what the interface needs to show it.
 *
 * The monitor feeds it from the source: {@link setSchema} when the variables change,
 * {@link openRun} when a stream opens, {@link closeRun} when it ends or is replaced,
 * {@link append} for every sample, {@link markBoundary} when the source loses the robot, and
 * {@link setLatestValue} for read answers. It knows nothing about any link. Times are on the
 * session timeline, in microseconds, kept moving forward across reboots by the source.
 *
 * History is kept per variable name and type, so that it survives a schema change; queries take
 * a name, or an id of the current schema. Readers subscribe and hear about changes at most once
 * per scheduler tick. {@link version}, {@link latest}, {@link history}, {@link variable},
 * {@link timeRange}, {@link historyMark}, {@link boundaries} and {@link status} return the same
 * value until something changes, so they can back `useSyncExternalStore` directly.
 */
export class HistoryStore {
  private readonly blockSize: number;
  private readonly registry: VariableRegistry;
  private readonly runs = new Map<number, OpenRun>();
  private readonly openBySlot = new Map<number, StreamRun>();
  private boundaryList: readonly Boundary[] = [];
  private readonly listeners = new Set<(event: StoreWarning) => void>();
  private readonly ingestionListeners = new Set<(event: IngestionEvent) => void>();
  private readonly notifier: TickNotifier;
  private readonly memory: BlockMemory;
  private readonly host: StreamRunHost;
  private readonly statusChannel = new ChangeSignal();
  private readonly infoCache = new WeakMap<VariableHistory, Cached<VariableInfo>>();
  private readonly rangeCache = new WeakMap<VariableHistory, Cached<TimeRange | undefined>>();
  private readonly lastIds = new WeakMap<VariableHistory, number>();
  private sessionRange: Cached<TimeRange | undefined> | undefined;
  private statusSnapshot: StoreStatus;
  private historyVersion = 0;
  private resets = 0;
  private clockUs = Number.NEGATIVE_INFINITY;

  /**
   * @param options The scheduler, and the sizes and limits to use.
   */
  constructor(options: HistoryStoreOptions) {
    this.blockSize = checkBlockSize(options.blockSize ?? DEFAULT_BLOCK_SIZE);
    this.registry = new VariableRegistry(options.historyLength ?? 32);
    this.notifier = new TickNotifier(options.scheduler);
    this.memory = new BlockMemory({
      capBytes: options.memoryCapBytes ?? DEFAULT_MEMORY_CAP_BYTES,
      warningRatio: options.warningRatio ?? 0.8,
      scheduler: options.scheduler,
      now: options.now ?? Date.now,
      flushIntervalMs: options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS,
      maxConcurrentLoads: options.maxConcurrentLoads ?? 4,
      emit: (event) => this.emit(event),
      statusChanged: () => this.refreshStatus(),
      sealOpenBlocks: () => {
        for (const run of this.openBySlot.values()) {
          run.sealOpenBlock();
        }
      },
      reloaded: (block) => this.rewriteRun(block.ref.runId),
      evicted: (block) => this.rewriteRun(block.ref.runId),
      dropped: (block) => this.dropBlock(block),
    });
    this.host = {
      allocate: (layout) => this.memory.allocate(layout),
      seal: (block) => this.memory.seal(block),
      account: (bytes) => this.memory.account(bytes),
      gapFinal: (run, gap) => this.ingest({ type: 'gap', gap: run.recordedGap(gap) }),
    };
    this.statusSnapshot = this.memory.status();
  }

  /**
   * Take the robot's schema, which maps its ids to names. A name that comes back with another
   * type starts a new history, and a boundary marks the change.
   *
   * @param entries Every variable of the schema.
   * @param timeUs When the schema took effect; the latest sample's time by default.
   */
  setSchema(entries: readonly HistoryVariable[], timeUs = this.clockUs): void {
    if (this.registry.setSchema(entries) && Number.isFinite(timeUs)) {
      this.addBoundary('schema', timeUs);
    }

    this.notifier.touch(this.statusChannel);
  }

  /**
   * Start a run: a stream the source opened. Any open run it conflicts with, in the same slot or
   * sharing a variable, closes first, so the order the streams open in does not matter.
   *
   * @returns The ids of the runs it closed that way.
   * @throws If the run id was used before or a variable appears twice.
   */
  openRun(spec: StreamRunSpec): readonly number[] {
    if (this.runs.has(spec.runId)) {
      throw new Error(`Run ${spec.runId} was already opened`);
    }

    if (new Set(spec.variables.map((variable) => variable.id)).size !== spec.variables.length) {
      throw new Error(`Run ${spec.runId} names a variable twice`);
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

    const closed: number[] = [];

    for (const open of this.runs.values()) {
      const conflicts =
        open.run.slot === spec.slot || open.records.some((record) => records.includes(record));

      if (!open.run.closed && conflicts) {
        this.closeRun(open.run.id);
        closed.push(open.run.id);
      }
    }

    const run = new StreamRun(
      { runId: spec.runId, slot: spec.slot, variables },
      this.blockSize,
      this.host
    );

    records.forEach((record, index) => {
      record.segments.push({ run, column: run.columnOf[index] });
      record.appended();
      this.notifier.touch(record.channel);
    });

    this.runs.set(spec.runId, { run, records });
    this.openBySlot.set(spec.slot, run);
    this.ingest({ type: 'run-opened', run: run.recorded });
    this.notifier.touch(this.statusChannel);
    return closed;
  }

  /**
   * Close a run: its stream ended or was replaced. Closing a closed run does nothing.
   *
   * @throws If no run has that id.
   */
  closeRun(runId: number): void {
    const open = this.runs.get(runId);

    if (!open) {
      throw new Error(`No run ${runId}`);
    }

    if (open.run.closed) {
      return;
    }

    open.run.close();

    if (this.openBySlot.get(open.run.slot) === open.run) {
      this.openBySlot.delete(open.run.slot);
    }

    for (const record of open.records) {
      record.appended();
      this.notifier.touch(record.channel);
    }

    this.ingest({ type: 'run-closed', runId });
    this.notifier.touch(this.statusChannel);
  }

  /**
   * Add a sample of an open run. The latest values always take it; the history leaves out a
   * sample whose time repeats the previous one's, a duplicate, and one whose time goes back,
   * which also raises a `time-backwards` event.
   *
   * @param runId The run.
   * @param timeUs When the robot took it, on the session timeline.
   * @param values One value per variable, in the run's order.
   * @param missedBefore How many samples of the run the source lost just before this one,
   *   which the history keeps as a gap of dropped samples.
   * @throws If the run is not open or the number of values is wrong.
   */
  append(runId: number, timeUs: number, values: ArrayLike<Value>, missedBefore = 0): void {
    const { run, records } = this.openRunOf(runId);

    if (values.length !== records.length) {
      throw new RangeError(`Run ${runId} takes ${records.length} values, got ${values.length}`);
    }

    const received = run.receive(timeUs, missedBefore);

    if (received === RECEIVED_BACKWARDS) {
      this.emit({ type: 'time-backwards', runId, timeUs, lastUs: run.lastTimeUs });
    }

    const kept = received >= 0;
    const stored = kept && run.store(timeUs, values);

    if (kept) {
      this.clockUs = Math.max(this.clockUs, timeUs);
      this.historyVersion++;
    }

    for (let index = 0; index < records.length; index++) {
      const record = records[index];
      const value = values[index];
      record.setLatest(value, timeUs);

      if (run.columnOf[index] < 0) {
        record.remember(value, timeUs);
        this.ingestValue(record, run.variables[index].id, value, timeUs);
      } else if (kept) {
        this.checkPrecision(record, run.wide[index], value);

        if (stored) {
          record.tailUs = timeUs;
          record.appended();
        }
      }

      this.notifier.touch(record.channel);
    }

    this.memory.flushIfDue();
  }

  /**
   * Note that the link lost track of the robot. Every open run closes, and no line is drawn
   * across the moment.
   */
  markBoundary(kind: BoundaryKind, timeUs: number): void {
    this.addBoundary(kind, timeUs);

    for (const run of this.openBySlot.values()) {
      this.closeRun(run.id);
    }
  }

  /**
   * Record a value that did not come in a stream sample, such as a READ answer or a blob.
   *
   * @param variableId The variable, in the current schema.
   * @param value The value as decoded.
   * @param timeUs When it was sampled, if known.
   */
  setLatestValue(variableId: number, value: Value, timeUs?: number): void {
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
   * runs, which carry on from nothing. A persistence layer written before is no longer read.
   */
  reset(): void {
    for (const { run } of this.runs.values()) {
      if (!run.closed) {
        run.clearHistory();
      }
    }

    this.memory.reset();

    for (const [runId, { run }] of this.runs) {
      if (run.closed) {
        this.runs.delete(runId);
      }
    }

    for (const record of this.registry.all()) {
      const open = record.segments.filter((segment) => !segment.run.closed);
      record.segments.length = 0;
      record.segments.push(...open);
      record.tailUs = Number.NEGATIVE_INFINITY;
      record.rewritten();
      this.notifier.touch(record.channel);
    }

    this.boundaryList = [];
    this.historyVersion++;
    this.resets++;
    this.refreshStatus();
  }

  /**
   * Fill an empty store with a saved session, to read it: its schema, runs, blocks, gaps,
   * boundaries and values. Every run ends closed. Each block counts as having a copy in
   * `source`, so under the memory cap it leaves memory, oldest first, and comes back from there
   * when a query needs its raw samples; its pyramid stays. The latest value of a numeric
   * variable is its last stored sample.
   *
   * @param session What to load; its blocks are decoded one at a time.
   * @param source Where the blocks can be read back from.
   * @returns How many blocks did not fit under the cap and were left out.
   * @throws If the store already holds runs, or a block does not fit its run.
   */
  load(session: StoredRecording, source: BlockBacking): number {
    if (this.runs.size > 0) {
      throw new Error('Only an empty store can load a saved session');
    }

    this.registry.setSchema(session.schema);
    const lastSamples = new Map<VariableHistory, SampleValue>();
    let skipped = 0;

    for (const stored of session.runs) {
      const { run, records } = this.restoreRun(stored.run);

      for (const persisted of stored.blocks) {
        const block = run.restoreBlock(persisted);

        if (!block) {
          skipped++;
          continue;
        }

        this.memory.adopt(block, source);
        this.noteLastSamples(run, records, persisted, lastSamples);
      }

      for (const gap of stored.gaps) {
        run.restoreGap(gap);
      }

      run.finishRestore();
    }

    this.boundaryList = session.boundaries.toSorted((left, right) => left.timeUs - right.timeUs);

    for (const { variableId, name, timeUs, value } of session.values) {
      const record = this.registry.recordFor(name, this.registry.typeOf(variableId));
      this.lastIds.set(record, variableId);
      record.setLatest(value, Number.isNaN(timeUs) ? undefined : timeUs);

      if (!record.numeric) {
        record.remember(value, Number.isNaN(timeUs) ? undefined : timeUs);
      }
    }

    for (const [record, sample] of lastSamples) {
      record.setLatest(sample.value, sample.timeUs);
      record.tailUs = sample.timeUs;
    }

    for (const record of this.registry.all()) {
      record.rewritten();
      this.notifier.touch(record.channel);
    }

    this.clockUs = Math.max(this.clockUs, ...[...lastSamples.values()].map((s) => s.timeUs));
    this.historyVersion++;
    this.refreshStatus();
    return skipped;
  }

  /** How many times the history was forgotten by {@link reset}, to tell a fresh one from a longer one. */
  get generation(): number {
    return this.resets;
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

    let storedSamples = 0;
    let droppedSamples = 0;

    for (const { run } of record.segments) {
      storedSamples += run.keptCount;
      droppedSamples += run.droppedCount;
    }

    const cached = this.infoCache.get(record)?.value;

    if (
      cached !== undefined &&
      cached.type === record.type &&
      cached.precisionLost === record.precisionLost &&
      cached.storedSamples === storedSamples &&
      cached.droppedSamples === droppedSamples &&
      cached.runs === record.segments.length
    ) {
      return cached;
    }

    const value: VariableInfo = {
      name: record.name,
      type: record.type,
      storage: record.type === undefined ? undefined : (columnKindOf(record.type) ?? 'none'),
      precisionLost: record.precisionLost,
      storedSamples,
      droppedSamples,
      runs: record.segments.length,
    };
    this.infoCache.set(record, { version: record.mark.version, value });
    return value;
  }

  /**
   * The span of the kept history, of one variable or of the whole session, as a half-open range
   * that holds the last sample; the same object until it changes.
   */
  timeRange(variable?: VariableRef): TimeRange | undefined {
    if (variable === undefined) {
      if (this.sessionRange?.version !== this.historyVersion) {
        const runs = [...this.runs.values()].map(({ run }) => run);
        this.sessionRange = { version: this.historyVersion, value: this.rangeOf(runs) };
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

    const runs = record.segments.filter((segment) => segment.column >= 0).map((s) => s.run);
    const value = this.rangeOf(runs);
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

    this.memory.beginQuery();

    for (const { run, column } of record.segments) {
      if (column < 0) {
        continue;
      }

      const blocks = run.blocks;

      for (let at = firstBlockFrom(blocks, startUs); at < blocks.length; at++) {
        const block = blocks[at];

        if (block.length === 0) {
          continue;
        }

        if (block.firstTimeUs >= endUs) {
          break;
        }

        const samples = this.runOf(block, column, startUs, endUs);

        if (samples) {
          yield { runId: run.id, ...samples };
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
    this.memory.beginQuery();

    for (let index = segments.length - 1; index >= 0; index--) {
      const { run, column } = segments[index];
      const block = blockAt(run.blocks, timeUs);

      if (column < 0 || !block) {
        continue;
      }

      this.memory.markUsed(block);
      const time = block.time;
      const columns = block.columns;

      if (!time || !columns) {
        this.memory.request(block);
        return undefined;
      }

      const at = upperBound(time, timeUs, 0, block.length) - 1;
      return { value: columns[column][at], timeUs: time[at] };
    }

    return undefined;
  }

  /**
   * The minimum and maximum of a variable per pixel column of `[startUs, endUs)`, with where its
   * line breaks: between runs, at dropped samples, at boundaries and after NaN. Lay the result
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

    this.memory.beginQuery();
    decimateSegments(into, record.segments, this.boundaryList, this.memory, options.stats);
    into.source = record;
    into.mark = mark;
    return into;
  }

  /**
   * Why a variable has no samples in parts of `[startUs, endUs)`: time between its runs,
   * dropped samples and samples not kept, ordered by start.
   */
  gaps(variable: VariableRef, startUs: number, endUs: number): Gap[] {
    const found: Gap[] = [];
    let coveredUntil = Number.NaN;

    for (const { run, column } of this.registry.resolve(variable)?.segments ?? []) {
      if (column < 0) {
        continue;
      }

      if (run.storedCount > 0) {
        if (
          run.firstStoredUs > coveredUntil &&
          overlaps(coveredUntil, run.firstStoredUs, startUs, endUs)
        ) {
          found.push({ kind: 'not-streamed', startUs: coveredUntil, endUs: run.firstStoredUs });
        }

        coveredUntil = Number.isNaN(coveredUntil)
          ? run.lastTimeUs
          : Math.max(coveredUntil, run.lastTimeUs);
      }

      for (const gap of run.gaps) {
        const gapStart = Number.isNaN(gap.startUs) ? gap.untilUs : gap.startUs;

        if (overlaps(gapStart, gap.untilUs, startUs, endUs)) {
          found.push({ kind: gap.kind, startUs: gapStart, endUs: gap.untilUs, count: gap.count });
        }
      }

      if (run.unstoredRun > 0 && overlaps(run.unstoredFrom, Number.NaN, startUs, endUs)) {
        found.push({
          kind: 'not-stored',
          startUs: run.unstoredFrom,
          endUs: Number.NaN,
          count: run.unstoredRun,
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
   * Hear about changes to the status, the schema, the runs and the boundaries, at most once
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
  onEvent(listener: (event: StoreWarning) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Hear, as they happen, about what a recorder writes besides the blocks: runs opening and
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
   * far, for a recorder that starts late: every run and its final gaps, the boundaries, and the
   * latest value of each variable not stored numerically.
   */
  replayIngestion(listener: (event: IngestionEvent) => void): void {
    for (const { run } of this.runs.values()) {
      listener({ type: 'run-opened', run: run.recorded });

      for (const gap of run.gaps) {
        if (run.closed || !Number.isNaN(gap.untilUs)) {
          listener({ type: 'gap', gap: run.recordedGap(gap) });
        }
      }

      if (run.closed) {
        listener({ type: 'run-closed', runId: run.id });
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
  startRecording(persistence: BlockBacking): void {
    this.memory.startRecording(persistence);
  }

  /**
   * While recording, seal and write the blocks being filled if the flush interval has passed
   * since they last were. Samples do this as they arrive; a timer calls it too, so that the last
   * samples before the stream goes quiet reach the persistence layer as well.
   */
  flushIfDue(): void {
    this.memory.flushIfDue();
  }

  /**
   * Write what is being filled, then stop writing blocks. Blocks already written can still leave
   * memory and come back.
   *
   * @returns A promise that settles once every write under way has.
   */
  stopRecording(): Promise<void> {
    return this.memory.stopRecording();
  }

  private restoreRun(recorded: RecordedRun): OpenRun {
    if (this.runs.has(recorded.runId)) {
      throw new Error(`Run ${recorded.runId} appears twice in the session`);
    }

    const run = new StreamRun(recorded, this.blockSize, this.host);
    const records = recorded.variables.map(({ id, name, type }) => {
      const record = this.registry.recordFor(name, type);
      this.lastIds.set(record, id);
      return record;
    });
    records.forEach((record, index) => {
      record.segments.push({ run, column: run.columnOf[index] });
    });
    const open = { run, records };
    this.runs.set(recorded.runId, open);
    return open;
  }

  private noteLastSamples(
    run: StreamRun,
    records: readonly VariableHistory[],
    persisted: BlockData,
    lastSamples: Map<VariableHistory, SampleValue>
  ): void {
    const last = persisted.time.length - 1;

    if (last < 0) {
      return;
    }

    const timeUs = persisted.time[last];

    records.forEach((record, index) => {
      const column = run.columnOf[index];
      const known = lastSamples.get(record);

      if (column >= 0 && (known === undefined || known.timeUs <= timeUs)) {
        lastSamples.set(record, { value: persisted.columns[column].values[last], timeUs });
      }
    });
  }

  private openRunOf(runId: number): OpenRun {
    const open = this.runs.get(runId);

    if (!open) {
      throw new Error(`No run ${runId}`);
    }

    if (open.run.closed) {
      throw new Error(`Run ${runId} is closed`);
    }

    return open;
  }

  private checkPrecision(record: VariableHistory, wide: boolean, value: Value): void {
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

  private rangeOf(runs: readonly StreamRun[]): TimeRange | undefined {
    let startUs = Number.POSITIVE_INFINITY;
    let lastUs = Number.NEGATIVE_INFINITY;

    for (const run of runs) {
      if (run.keptCount > 0) {
        startUs = Math.min(startUs, run.firstTimeUs);
        lastUs = Math.max(lastUs, run.lastTimeUs);
      }
    }

    return startUs <= lastUs ? { startUs, endUs: nextUp(lastUs) } : undefined;
  }

  private runOf(
    block: Block,
    column: number,
    startUs: number,
    endUs: number
  ): Omit<SampleRun, 'runId'> | undefined {
    this.memory.markUsed(block);
    const time = block.time;
    const columns = block.columns;

    if (!time || !columns) {
      this.memory.request(block);
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
    this.runs.get(block.ref.runId)?.run.dropBlock(block);
    this.historyVersion++;
    this.rewriteRun(block.ref.runId);
  }

  private rewriteRun(runId: number): void {
    for (const record of this.runs.get(runId)?.records ?? []) {
      record.rewritten();
      this.notifier.touch(record.channel);
    }
  }

  private ingestValue(
    record: VariableHistory,
    variableId: number,
    value: Value,
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
    this.statusSnapshot = this.memory.status();
    this.notifier.touch(this.statusChannel);
  }

  private emit(event: StoreWarning): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}
