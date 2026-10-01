import type { Unsubscribe } from '@/core/emitter';
import type { Value } from '@/core/variables';

import type { BlockBacking, BlockData } from './block-backing';
import type { Decimation } from './decimation';
import { HistoryIngest } from './ingest';
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
  variableInfo,
  type VariableInfo,
} from './queries';
import type { Scheduler } from './scheduler';
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
 * changes go through `ingest.ts`, the reads through `queries.ts`.
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
  readonly #ingest: HistoryIngest;
  #sessionRange: TimeRange | undefined;

  /**
   * @param options The scheduler, and the sizes and limits to use.
   */
  constructor(options: HistoryStoreOptions) {
    this.#ingest = new HistoryIngest({
      scheduler: options.scheduler,
      blockSize: checkBlockSize(options.blockSize ?? DEFAULT_BLOCK_SIZE),
      memoryCapBytes: options.memoryCapBytes ?? DEFAULT_MEMORY_CAP_BYTES,
      warningRatio: options.warningRatio ?? 0.8,
      historyLength: options.historyLength ?? 32,
      now: options.now ?? Date.now,
      flushIntervalMs: options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS,
      maxConcurrentLoads: options.maxConcurrentLoads ?? 4,
    });
  }

  /**
   * Take the robot's schema, which maps its ids to names. A name that comes back with another
   * type starts a new history, and a boundary marks the change.
   *
   * @param entries Every variable of the schema.
   * @param timeUs When the schema took effect; the latest sample's time by default.
   */
  setSchema(entries: readonly HistoryVariable[], timeUs?: number): void {
    this.#ingest.setSchema(entries, timeUs);
  }

  /**
   * Start a run: a stream the source opened. Any open run it conflicts with, in the same slot or
   * sharing a variable, closes first, so the order the streams open in does not matter.
   *
   * @returns The ids of the runs it closed that way.
   * @throws If the run id was used before or a variable appears twice.
   */
  openRun(spec: StreamRunSpec): readonly number[] {
    return this.#ingest.openRun(spec);
  }

  /**
   * Close a run: its stream ended or was replaced. Closing a closed run does nothing.
   *
   * @throws If no run has that id.
   */
  closeRun(runId: number): void {
    this.#ingest.closeRun(runId);
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
    this.#ingest.append(runId, timeUs, values, missedBefore);
  }

  /**
   * Note that the link lost track of the robot. Every open run closes, and no line is drawn
   * across the moment.
   */
  markBoundary(kind: BoundaryKind, timeUs: number): void {
    this.#ingest.markBoundary(kind, timeUs);
  }

  /**
   * Record a value that did not come in a stream sample, such as a READ answer or a blob.
   *
   * @param variableId The variable, in the current schema.
   * @param value The value as decoded.
   * @param timeUs When it was sampled, if known.
   */
  setLatestValue(variableId: number, value: Value, timeUs?: number): void {
    this.#ingest.setLatestValue(variableId, value, timeUs);
  }

  /**
   * Forget the history and stop recording, keeping the schema, the latest values and the open
   * runs, which carry on from nothing. A persistence layer written before is no longer read.
   */
  reset(): void {
    this.#ingest.reset();
  }

  /**
   * Take back a run of a saved recording, closed, with its gaps and its blocks. Each block counts
   * as having a copy in `source`, so under the memory cap it leaves memory, oldest first, and
   * comes back from there when a query needs its raw samples; its pyramid stays. Its numeric
   * variables take its last sample as their latest value.
   *
   * @param run The run, with the names its variables had.
   * @param blocks Its blocks, in index order.
   * @param gaps Its gaps, in the order they were written; a later one with the start of an
   *   earlier one replaces it.
   * @param source Where the blocks can be read back from.
   * @returns How many blocks did not fit under the cap and were left out.
   * @throws If the run appears twice, or a block does not fit it.
   */
  restoreRun(
    run: RecordedRun,
    blocks: Iterable<BlockData>,
    gaps: readonly RecordedGap[],
    source: BlockBacking
  ): number {
    return this.#ingest.restoreRun(run, blocks, gaps, source);
  }

  /**
   * Take back a value of a saved recording that was not part of a stored stream. A variable
   * with stored samples keeps its last one as its latest value.
   */
  restoreValue(value: RecordedValue): void {
    this.#ingest.restoreValue(value);
  }

  /** How many times the history was forgotten by {@link reset}, to tell a fresh one from a longer one. */
  get resetCount(): number {
    return this.#ingest.resetCount;
  }

  /** The latest value of a variable; the same object until it changes. */
  latest(variable: VariableRef): LatestValue | undefined {
    return this.#ingest.registry.resolve(variable)?.latest;
  }

  /**
   * The last values of a variable that is not stored numerically, such as a blob, oldest first;
   * the same array until a value arrives.
   */
  history(variable: VariableRef): readonly LatestValue[] {
    return this.#ingest.registry.resolve(variable)?.history ?? NO_VALUES;
  }

  /** What the store knows about a variable: its storage and how many samples it kept and lost. */
  variable(variable: VariableRef): VariableInfo | undefined {
    const record = this.#ingest.registry.resolve(variable);
    return record && variableInfo(record);
  }

  /**
   * The span of the kept history, of one variable or of the whole session, as a half-open range
   * that holds the last sample; the same object until it changes.
   */
  timeRange(variable?: VariableRef): TimeRange | undefined {
    if (variable !== undefined) {
      const record = this.#ingest.registry.resolve(variable);
      return record && rangeOfHistory(record);
    }

    const range = rangeOf(this.#ingest.runs.values());
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
    return this.#ingest.registry.resolve(variable)?.mark;
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
    const record = this.#ingest.registry.resolve(variable);

    if (record) {
      yield* samplesOf(record.segments, startUs, endUs, this.#ingest.memory.loader);
    }
  }

  /**
   * The stored sample of a variable at a time, or the last one before it, for cursors synced
   * across plots. Undefined before the first sample, or while its block is being read back.
   */
  valueAt(variable: VariableRef, timeUs: number): SampleValue | undefined {
    const segments = this.#ingest.registry.resolve(variable)?.segments ?? [];
    return valueAt(segments, timeUs, this.#ingest.memory.loader);
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
      this.#ingest.registry.resolve(variable),
      startUs,
      endUs,
      pixels,
      this.#ingest.boundaries,
      this.#ingest.memory.loader,
      options
    );
  }

  /**
   * Why a variable has no samples in parts of `[startUs, endUs)`: time between its runs,
   * dropped samples and samples not kept, ordered by start.
   */
  gaps(variable: VariableRef, startUs: number, endUs: number): Gap[] {
    return gapsOf(this.#ingest.registry.resolve(variable)?.segments ?? [], startUs, endUs);
  }

  /** Every boundary so far, oldest first; the same array until a boundary is added. */
  boundaries(): readonly Boundary[] {
    return this.#ingest.boundaries;
  }

  /**
   * A number that changes whenever anything a reader can see of a variable changes; the snapshot
   * for `useSyncExternalStore`.
   */
  version(variable: VariableRef): number {
    return this.#ingest.registry.channelFor(variable).version;
  }

  /**
   * Hear about changes to some variables, at most once per scheduler tick. A name keeps being
   * followed across schema changes; an id is taken as the name it has now.
   *
   * @returns A function that ends the subscription.
   */
  subscribe(variables: readonly VariableRef[], callback: () => void): () => void {
    const channels = variables.map((variable) => this.#ingest.registry.channelFor(variable));
    return this.#ingest.notifier.subscribe(channels, callback);
  }

  /**
   * Hear about changes to the status, the schema, the runs and the boundaries, at most once
   * per tick.
   *
   * @returns A function that ends the subscription.
   */
  subscribeStatus(callback: () => void): () => void {
    return this.#ingest.notifier.subscribe([this.#ingest.statusSignal], callback);
  }

  /** The memory used and the recording state; the same object until it changes. */
  status(): StoreStatus {
    return this.#ingest.memory.status();
  }

  /**
   * Hear about warnings as they happen: memory, precision, time and persistence.
   *
   * @returns A function that stops listening.
   */
  onWarning(listener: (warning: StoreWarning) => void): Unsubscribe {
    return this.#ingest.warnings.on('warning', listener);
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
    return this.#ingest.follow(listener);
  }

  /**
   * Start writing blocks to a persistence layer: the whole session so far first, then every
   * block as it seals, and the blocks being filled every few seconds. Blocks written may leave
   * memory under the cap and come back when a query needs them. The records besides the blocks
   * come from {@link follow}.
   */
  startRecording(persistence: BlockBacking): void {
    this.#ingest.memory.writer.start(persistence);
  }

  /**
   * While recording, seal and write the blocks being filled if the flush interval has passed
   * since they last were. Samples do this as they arrive; a timer calls it too, so that the last
   * samples before the stream goes quiet reach the persistence layer as well.
   */
  flushIfDue(): void {
    this.#ingest.memory.writer.flushIfDue();
  }

  /**
   * Write what is being filled, then stop writing blocks. Blocks already written can still leave
   * memory and come back.
   *
   * @returns A promise that settles once every write under way has.
   */
  stopRecording(): Promise<void> {
    return this.#ingest.memory.writer.stop();
  }
}
