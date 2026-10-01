import { Emitter, type Unsubscribe } from '@/core/emitter';
import type { Value } from '@/core/variables';

import type { BlockBacking, BlockData } from './block-backing';
import { losesPrecision } from './columns';
import type { Decimation } from './decimation';
import { BlockMemory } from './memory/block-memory';
import { LEAF_SIZE } from './min-max-pyramid';
import {
  changedSince,
  decimate,
  type DecimateOptions,
  gapsOf,
  rangeOf,
  rangeOfHistory,
  samplesOf,
  valueAt,
} from './queries';
import type { Scheduler } from './scheduler';
import { RECEIVED_BACKWARDS, StreamRun } from './stream-run';
import { ChangeSignal, TickNotifier } from './tick-notifier';
import type {
  Boundary,
  BoundaryKind,
  Gap,
  HistoryMark,
  HistoryVariable,
  LatestValue,
  RecordedGap,
  RecordedRun,
  RecordedValue,
  RecordingRecord,
  SampleRun,
  SampleValue,
  StoreStatus,
  StoreWarning,
  StreamRunSpec,
  TimeRange,
  VariableRef,
} from './types';
import type { VariableHistory } from './variable-history';
import { VariableRegistry } from './variable-registry';

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

const NO_VALUES: readonly LatestValue[] = [];

function checkBlockSize(size: number): number {
  if (!Number.isInteger(size) || size < LEAF_SIZE || (size & (size - 1)) !== 0) {
    throw new RangeError(`Block size must be a power of two of at least ${LEAF_SIZE}, got ${size}`);
  }

  return size;
}

/**
 * Every sample of the session, and what the interface needs to show it.
 *
 * The monitor feeds it from the source: {@link setSchema} when the variables change,
 * {@link openRun} when a stream opens, {@link closeRun} when it ends or is replaced,
 * {@link append} for every sample, {@link markBoundary} when the source loses the robot, and
 * {@link setLatestValue} for read answers. It knows nothing about any link. Times are on the
 * session timeline, in microseconds, kept moving forward across reboots by the source. The
 * reads are the functions of `queries.ts` over a variable's runs.
 *
 * History is kept per variable name and type, so that it survives a schema change; queries take
 * a name, or an id of the current schema. Readers subscribe and hear about changes at most once
 * per scheduler tick. {@link version}, {@link latest}, {@link history}, {@link timeRange},
 * {@link historyMark}, {@link boundaries} and {@link status} return the same value until
 * something changes, so they can back `useSyncExternalStore` directly.
 *
 * A recording follows the store with {@link follow} and {@link startRecording}, and
 * `loadRecording` fills a new one from a recording with {@link restoreRun} and
 * {@link restoreValue}.
 */
export class HistoryStore {
  readonly #blockSize: number;
  readonly #notifier: TickNotifier;
  readonly #statusSignal: ChangeSignal;
  readonly #registry: VariableRegistry;
  readonly #runs = new Map<number, StreamRun>();
  readonly #openBySlot = new Map<number, StreamRun>();
  readonly #memory: BlockMemory;
  readonly #warnings = new Emitter<{ warning: StoreWarning }>();
  readonly #records = new Emitter<{ record: RecordingRecord }>();
  #boundaries: readonly Boundary[] = [];
  #sessionRange: TimeRange | undefined;
  #clockUs = Number.NEGATIVE_INFINITY;
  #resetCount = 0;

  /**
   * @param options The scheduler, and the sizes and limits to use.
   */
  constructor(options: HistoryStoreOptions) {
    this.#blockSize = checkBlockSize(options.blockSize ?? DEFAULT_BLOCK_SIZE);
    this.#notifier = new TickNotifier(options.scheduler);
    this.#statusSignal = new ChangeSignal(this.#notifier);
    this.#registry = new VariableRegistry(options.historyLength ?? 32, this.#notifier);
    this.#memory = new BlockMemory({
      capBytes: options.memoryCapBytes ?? DEFAULT_MEMORY_CAP_BYTES,
      warningRatio: options.warningRatio ?? 0.8,
      scheduler: options.scheduler,
      now: options.now ?? Date.now,
      flushIntervalMs: options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS,
      maxConcurrentLoads: options.maxConcurrentLoads ?? 4,
      owners: this.#runs,
      warnings: this.#warnings,
      statusSignal: this.#statusSignal,
    });
  }

  /**
   * Take the robot's schema, which maps its ids to names. A name that comes back with another
   * type starts a new history, and a boundary marks the change.
   *
   * @param entries Every variable of the schema.
   * @param timeUs When the schema took effect; the latest sample's time by default.
   */
  setSchema(entries: readonly HistoryVariable[], timeUs = this.#clockUs): void {
    if (this.#registry.setSchema(entries) && Number.isFinite(timeUs)) {
      this.#addBoundary('schema', timeUs);
    }

    this.#statusSignal.touch();
  }

  /**
   * Start a run: a stream the source opened. Any open run it conflicts with, in the same slot or
   * sharing a variable, closes first, so the order the streams open in does not matter.
   *
   * @returns The ids of the runs it closed that way.
   * @throws If the run id was used before or a variable appears twice.
   */
  openRun(spec: StreamRunSpec): readonly number[] {
    if (this.#runs.has(spec.runId)) {
      throw new Error(`Run ${spec.runId} was already opened`);
    }

    if (new Set(spec.variables.map((variable) => variable.id)).size !== spec.variables.length) {
      throw new Error(`Run ${spec.runId} names a variable twice`);
    }

    const variables = spec.variables.map((variable) => ({
      id: variable.id,
      name: variable.name ?? this.#registry.nameOf(variable.id),
      type: variable.type,
    }));
    let typeChanged = false;
    const records = variables.map(({ id, name, type }) => {
      const before = this.#registry.resolve(name);
      const record = this.#registry.recordFor(name, type);
      typeChanged ||= before !== undefined && before !== record;
      record.lastId = id;
      return record;
    });

    if (typeChanged && Number.isFinite(this.#clockUs)) {
      this.#addBoundary('schema', this.#clockUs);
    }

    const closed: number[] = [];

    for (const open of this.#runs.values()) {
      const conflicts =
        open.slot === spec.slot || open.records.some((record) => records.includes(record));

      if (!open.closed && conflicts) {
        this.closeRun(open.id);
        closed.push(open.id);
      }
    }

    const run = new StreamRun(
      { runId: spec.runId, slot: spec.slot, variables },
      records,
      this.#blockSize,
      this.#memory
    );

    records.forEach((record, index) => {
      record.segments.push({ run, column: run.columnOf[index] });
      record.appended();
    });

    this.#runs.set(spec.runId, run);
    this.#openBySlot.set(spec.slot, run);
    this.#emit({ kind: 'run', run: run.recorded });
    this.#statusSignal.touch();
    return closed;
  }

  /**
   * Close a run: its stream ended or was replaced. Closing a closed run does nothing.
   *
   * @throws If no run has that id.
   */
  closeRun(runId: number): void {
    const run = this.#runs.get(runId);

    if (!run) {
      throw new Error(`No run ${runId}`);
    }

    if (run.closed) {
      return;
    }

    run.close();
    this.#emitFinalGaps(run);

    if (this.#openBySlot.get(run.slot) === run) {
      this.#openBySlot.delete(run.slot);
    }

    for (const record of run.records) {
      record.appended();
    }

    this.#emit({ kind: 'run-closed', runId });
    this.#statusSignal.touch();
  }

  /**
   * Add a sample of an open run. The latest values always take it; the history leaves out a
   * sample whose time repeats the previous one's, a duplicate, and one whose time goes back,
   * which also raises a `time-backwards` warning.
   *
   * @param runId The run.
   * @param timeUs When the robot took it, on the session timeline.
   * @param values One value per variable, in the run's order.
   * @param missedBefore How many samples of the run the source lost just before this one,
   *   which the history keeps as a gap of dropped samples.
   * @throws If the run is not open or the number of values is wrong.
   */
  append(runId: number, timeUs: number, values: ArrayLike<Value>, missedBefore = 0): void {
    const run = this.#openRun(runId);
    const records = run.records;

    if (values.length !== records.length) {
      throw new RangeError(`Run ${runId} takes ${records.length} values, got ${values.length}`);
    }

    const received = run.receive(timeUs, missedBefore);

    if (received === RECEIVED_BACKWARDS) {
      this.#warnings.emit('warning', {
        type: 'time-backwards',
        runId,
        timeUs,
        lastUs: run.lastTimeUs,
      });
    }

    const kept = received >= 0;
    const stored = kept && run.store(timeUs, values);

    if (stored) {
      this.#emitFinalGaps(run);
    }

    if (kept) {
      this.#clockUs = Math.max(this.#clockUs, timeUs);
    }

    for (let index = 0; index < records.length; index++) {
      const record = records[index];
      const value = values[index];
      const numeric = run.columnOf[index] >= 0;
      record.setLatest(value, timeUs);

      if (!numeric) {
        record.remember(value, timeUs);
        this.#emitValue(record, run.variables[index].id, value, timeUs);
      } else if (kept) {
        this.#checkPrecision(record, run.wide[index], value);
      }

      if (numeric && stored) {
        record.tailUs = timeUs;
        record.appended();
      } else {
        record.changed();
      }
    }

    this.#memory.flushIfDue();
  }

  /**
   * Note that the link lost track of the robot. Every open run closes, and no line is drawn
   * across the moment.
   */
  markBoundary(kind: BoundaryKind, timeUs: number): void {
    this.#addBoundary(kind, timeUs);

    for (const run of this.#openBySlot.values()) {
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
    const record = this.#registry.recordFor(
      this.#registry.nameOf(variableId),
      this.#registry.typeOf(variableId)
    );
    record.lastId = variableId;
    record.setLatest(value, timeUs);

    if (!record.numeric) {
      record.remember(value, timeUs);
    }

    record.changed();
    this.#emitValue(record, variableId, value, timeUs ?? Number.NaN);
  }

  /**
   * Forget the history and stop recording, keeping the schema, the latest values and the open
   * runs, which carry on from nothing. A persistence layer written before is no longer read.
   */
  reset(): void {
    for (const run of this.#runs.values()) {
      if (!run.closed) {
        run.clearHistory();
      }
    }

    this.#memory.reset();

    for (const [runId, run] of this.#runs) {
      if (run.closed) {
        this.#runs.delete(runId);
      }
    }

    for (const record of this.#registry.all()) {
      const open = record.segments.filter((segment) => !segment.run.closed);
      record.segments.length = 0;
      record.segments.push(...open);
      record.tailUs = Number.NEGATIVE_INFINITY;
      record.rewritten();
    }

    this.#boundaries = [];
    this.#resetCount++;
    this.#statusSignal.touch();
  }

  /**
   * Take back a run of a saved recording, closed, with its gaps and its blocks. Each block counts
   * as having a copy in `source`, so under the memory cap it leaves memory, oldest first, and
   * comes back from there when a query needs its raw samples; its pyramid stays. Its numeric
   * variables take its last sample as their latest value.
   *
   * @param recorded The run, with the names its variables had.
   * @param blocks Its blocks, in index order.
   * @param gaps Its gaps, in the order they were written; a later one with the start of an
   *   earlier one replaces it.
   * @param source Where the blocks can be read back from.
   * @returns How many blocks did not fit under the cap and were left out.
   * @throws If the run appears twice, or a block does not fit it.
   */
  restoreRun(
    recorded: RecordedRun,
    blocks: Iterable<BlockData>,
    gaps: readonly RecordedGap[],
    source: BlockBacking
  ): number {
    if (this.#runs.has(recorded.runId)) {
      throw new Error(`Run ${recorded.runId} appears twice in the session`);
    }

    const records = recorded.variables.map(({ id, name, type }) => {
      const record = this.#registry.recordFor(name, type);
      record.lastId = id;
      return record;
    });
    const run = new StreamRun(recorded, records, this.#blockSize, this.#memory);
    records.forEach((record, index) => {
      record.segments.push({ run, column: run.columnOf[index] });
    });
    this.#runs.set(recorded.runId, run);
    let skipped = 0;
    let last: BlockData | undefined;

    for (const data of blocks) {
      const block = run.restoreBlock(data);

      if (!block) {
        skipped++;
        continue;
      }

      this.#memory.adopt(block, source);
      last = data.time.length > 0 ? data : last;
    }

    run.finishRestore(gaps);

    if (last) {
      this.#takeLastSamples(run, last);
    }

    for (const record of records) {
      record.rewritten();
    }

    return skipped;
  }

  /**
   * Take back a value of a saved recording that was not part of a stored stream. A variable
   * with stored samples keeps its last one as its latest value.
   */
  restoreValue({ variableId, name, timeUs, value }: RecordedValue): void {
    const record = this.#registry.recordFor(name, this.#registry.typeOf(variableId));
    const time = Number.isNaN(timeUs) ? undefined : timeUs;
    record.lastId = variableId;

    if (record.tailUs === Number.NEGATIVE_INFINITY) {
      record.setLatest(value, time);
    }

    if (!record.numeric) {
      record.remember(value, time);
    }

    record.changed();
  }

  /** How many times the history was forgotten by {@link reset}, to tell a fresh one from a longer one. */
  get resetCount(): number {
    return this.#resetCount;
  }

  /** The latest value of a variable; the same object until it changes. */
  latest(variable: VariableRef): LatestValue | undefined {
    return this.#registry.resolve(variable)?.latest;
  }

  /**
   * The last values of a variable that is not stored numerically, such as a blob, oldest first;
   * the same array until a value arrives.
   */
  history(variable: VariableRef): readonly LatestValue[] {
    return this.#registry.resolve(variable)?.history ?? NO_VALUES;
  }

  /**
   * The span of the kept history, of one variable or of the whole session, as a half-open range
   * that holds the last sample; the same object until it changes.
   */
  timeRange(variable?: VariableRef): TimeRange | undefined {
    if (variable !== undefined) {
      const record = this.#registry.resolve(variable);
      return record && rangeOfHistory(record);
    }

    const range = rangeOf(this.#runs.values());
    const kept = this.#sessionRange;

    if (range?.startUs !== kept?.startUs || range?.endUs !== kept?.endUs) {
      this.#sessionRange = range;
    }

    return this.#sessionRange;
  }

  /**
   * Where a variable's history stands, to ask {@link changedSince} later; the same object until
   * it changes.
   */
  historyMark(variable: VariableRef): HistoryMark | undefined {
    return this.#registry.resolve(variable)?.mark;
  }

  /**
   * Whether a window of a variable's history may look different than when the mark was taken,
   * so that a paused plot redraws only when it has to: appends at the live end do not touch a
   * window that ends before them.
   */
  changedSince(variable: VariableRef, mark: HistoryMark | undefined, window: TimeRange): boolean {
    return changedSince(this.historyMark(variable), mark, window);
  }

  /**
   * The stored samples of a variable in `[startUs, endUs)`, as views into the store's blocks.
   *
   * Blocks evicted to the persistence layer are skipped and asked back; the variable's version
   * changes when they return.
   */
  *samples(variable: VariableRef, startUs: number, endUs: number): Generator<SampleRun> {
    const record = this.#registry.resolve(variable);

    if (record) {
      yield* samplesOf(record.segments, startUs, endUs, this.#memory);
    }
  }

  /**
   * The stored sample of a variable at a time, or the last one before it, for cursors synced
   * across plots. Undefined before the first sample, or while its block is being read back.
   */
  valueAt(variable: VariableRef, timeUs: number): SampleValue | undefined {
    const segments = this.#registry.resolve(variable)?.segments ?? [];
    return valueAt(segments, timeUs, this.#memory);
  }

  /**
   * The minimum and maximum of a variable per pixel column of `[startUs, endUs)`, with where its
   * line breaks: between runs, at dropped samples, at boundaries and after NaN. The plot lays
   * the result out for uPlot.
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
    return decimate(
      this.#registry.resolve(variable),
      startUs,
      endUs,
      pixels,
      this.#boundaries,
      this.#memory,
      options
    );
  }

  /**
   * Why a variable has no samples in parts of `[startUs, endUs)`: time between its runs,
   * dropped samples and samples not kept, ordered by start.
   */
  gaps(variable: VariableRef, startUs: number, endUs: number): Gap[] {
    return gapsOf(this.#registry.resolve(variable)?.segments ?? [], startUs, endUs);
  }

  /** Every boundary so far, oldest first; the same array until a boundary is added. */
  boundaries(): readonly Boundary[] {
    return this.#boundaries;
  }

  /**
   * A number that changes whenever anything a reader can see of a variable changes; the snapshot
   * for `useSyncExternalStore`.
   */
  version(variable: VariableRef): number {
    return this.#registry.channelFor(variable).version;
  }

  /**
   * Hear about changes to some variables, at most once per scheduler tick. A name keeps being
   * followed across schema changes; an id is taken as the name it has now.
   *
   * @returns A function that ends the subscription.
   */
  subscribe(variables: readonly VariableRef[], callback: () => void): () => void {
    const channels = variables.map((variable) => this.#registry.channelFor(variable));
    return this.#notifier.subscribe(channels, callback);
  }

  /**
   * Hear about changes to the status, the schema, the runs and the boundaries, at most once
   * per tick.
   *
   * @returns A function that ends the subscription.
   */
  subscribeStatus(callback: () => void): () => void {
    return this.#notifier.subscribe([this.#statusSignal], callback);
  }

  /** The memory used and the recording state; the same object until it changes. */
  status(): StoreStatus {
    return this.#memory.status();
  }

  /**
   * Hear about warnings as they happen: memory, precision, time and persistence.
   *
   * @returns A function that stops listening.
   */
  onWarning(listener: (warning: StoreWarning) => void): Unsubscribe {
    return this.#warnings.on('warning', listener);
  }

  /**
   * Hear what a recording writes besides the blocks: at once, every run of the session so far,
   * its final gaps and whether it closed, the boundaries and the latest value of each variable
   * not stored numerically; then each run opening and closing, gap once final, boundary and
   * value outside the stored streams as they happen.
   *
   * @returns A function that stops listening.
   */
  follow(listener: (record: RecordingRecord) => void): Unsubscribe {
    for (const record of this.#recordedSoFar()) {
      listener(record);
    }

    return this.#records.on('record', listener);
  }

  /**
   * Start writing blocks to a persistence layer: the whole session so far first, then every
   * block as it seals, and the blocks being filled every few seconds. Blocks written may leave
   * memory under the cap and come back when a query needs them. The records besides the blocks
   * come from {@link follow}.
   */
  startRecording(persistence: BlockBacking): void {
    this.#memory.startRecording(persistence);
  }

  /**
   * While recording, seal and write the blocks being filled if the flush interval has passed
   * since they last were. Samples do this as they arrive; a timer calls it too, so that the last
   * samples before the stream goes quiet reach the persistence layer as well.
   */
  flushIfDue(): void {
    this.#memory.flushIfDue();
  }

  /**
   * Write what is being filled, then stop writing blocks. Blocks already written can still leave
   * memory and come back.
   *
   * @returns A promise that settles once every write under way has.
   */
  stopRecording(): Promise<void> {
    return this.#memory.stopRecording();
  }

  *#recordedSoFar(): Generator<RecordingRecord> {
    for (const run of this.#runs.values()) {
      yield { kind: 'run', run: run.recorded };

      for (const gap of run.gaps) {
        if (run.closed || !Number.isNaN(gap.untilUs)) {
          yield { kind: 'gap', gap: run.recordedGap(gap) };
        }
      }

      if (run.closed) {
        yield { kind: 'run-closed', runId: run.id };
      }
    }

    for (const boundary of this.#boundaries) {
      yield { kind: 'boundary', boundary };
    }

    for (const record of this.#registry.all()) {
      const latest = record.latest;

      if (latest && !record.numeric && record.lastId !== undefined) {
        yield {
          kind: 'value',
          value: {
            variableId: record.lastId,
            name: record.name,
            timeUs: latest.timeUs ?? Number.NaN,
            value: latest.value,
          },
        };
      }
    }
  }

  #openRun(runId: number): StreamRun {
    const run = this.#runs.get(runId);

    if (!run) {
      throw new Error(`No run ${runId}`);
    }

    if (run.closed) {
      throw new Error(`Run ${runId} is closed`);
    }

    return run;
  }

  #takeLastSamples(run: StreamRun, last: BlockData): void {
    const at = last.time.length - 1;
    const timeUs = last.time[at];

    run.records.forEach((record, index) => {
      const column = run.columnOf[index];

      if (column >= 0 && record.tailUs <= timeUs) {
        record.setLatest(last.columns[column].values[at], timeUs);
        record.tailUs = timeUs;
        this.#clockUs = Math.max(this.#clockUs, timeUs);
      }
    });
  }

  #checkPrecision(record: VariableHistory, wide: boolean, value: Value): void {
    if (wide && !record.precisionLost && losesPrecision(value)) {
      record.precisionLost = true;
      this.#warnings.emit('warning', { type: 'precision-loss', name: record.name });
    }
  }

  #addBoundary(kind: BoundaryKind, timeUs: number): void {
    const boundary = { kind, timeUs };
    this.#boundaries = [...this.#boundaries, boundary];

    for (const record of this.#registry.all()) {
      if (timeUs < record.tailUs) {
        record.rewritten();
      } else {
        record.appended();
      }
    }

    this.#emit({ kind: 'boundary', boundary });
    this.#statusSignal.touch();
  }

  #emitFinalGaps(run: StreamRun): void {
    for (const gap of run.takeFinalGaps()) {
      this.#emit({ kind: 'gap', gap: run.recordedGap(gap) });
    }
  }

  #emitValue(record: VariableHistory, variableId: number, value: Value, timeUs: number): void {
    if (this.#records.has('record')) {
      this.#emit({ kind: 'value', value: { variableId, name: record.name, timeUs, value } });
    }
  }

  #emit(record: RecordingRecord): void {
    this.#records.emit('record', record);
  }
}
