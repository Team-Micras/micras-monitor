import type { HistoryProblem } from '@/core/monitor';
import type { Value, ValueType, Variable } from '@/core/variables';

import type { BlockData } from './block-backing';

/**
 * A column of stored values: 32 bit floats for the narrow types, 64 bit floats for the rest.
 */
export type NumericColumn = Float32Array | Float64Array;

/**
 * What the history needs of a variable: the id samples name it by, and the name and type its
 * history is keyed by.
 */
export type HistoryVariable = Pick<Variable, 'id' | 'name' | 'type'>;

/**
 * How queries name a variable: by name, or by its id in the current schema, for its current
 * history; or by name and type, for the history it had with that type.
 */
export type VariableRef = string | number | { readonly name: string; readonly type: ValueType };

/**
 * Why no line is drawn across a moment: the link lost the robot, or a variable changed type.
 */
export type BoundaryKind = 'reconnect' | 'reboot' | 'schema';

/**
 * A moment where the link lost track of the robot, or the schema changed. No line is drawn across
 * it.
 */
export interface Boundary {
  /** What happened. */
  readonly kind: BoundaryKind;

  /** When it happened, on the session timeline. */
  readonly timeUs: number;
}

/**
 * Why a stretch of a variable's history has no samples.
 *
 * - `not-streamed`: the variable was in no stream at the time.
 * - `dropped`: it was in a stream, and the source lost samples it knows the robot took.
 * - `not-stored`: they arrived, but the memory cap kept the store from keeping them, or made it
 *   let go of them later.
 */
export type GapKind = 'not-streamed' | 'dropped' | 'not-stored';

/**
 * A stretch of a variable's history with no samples.
 */
export interface Gap {
  /** Why there are no samples. */
  readonly kind: GapKind;

  /** Where the gap starts: the last sample before it, or the first sample not kept. */
  readonly startUs: number;

  /** The time of the first sample after it, or NaN if none arrived yet. */
  readonly endUs: number;

  /** How many samples are missing, when known (dropped and not stored). */
  readonly count?: number;
}

/**
 * A half-open span of time, `[startUs, endUs)`, as every query takes it.
 */
export interface TimeRange {
  /** The first time, inclusive. */
  readonly startUs: number;

  /** The end, exclusive. */
  readonly endUs: number;
}

/**
 * The most recent value of a variable.
 */
export interface LatestValue {
  /** The value as it was decoded, so 64 bit integers keep every bit. */
  readonly value: Value;

  /** When the robot sampled it, if known; a READ answer carries no timestamp. */
  readonly timeUs: number | undefined;
}

/**
 * A stored sample.
 */
export interface SampleValue {
  /** The value as stored, a float. */
  readonly value: number;

  /** When it was taken. */
  readonly timeUs: number;
}

/**
 * A run of stored samples of one variable, as views into the store's own blocks.
 *
 * The arrays are not copies: read them before the next append and do not write to them.
 */
export interface SampleRun {
  /** The run the samples belong to. */
  readonly runId: number;

  /** The sample times, on the session timeline. */
  readonly time: Float64Array;

  /** The values, one per time. */
  readonly values: NumericColumn;
}

/**
 * Where a variable's history stood when a reader last looked, to ask later whether a window of it
 * changed since.
 */
export interface HistoryMark {
  /** Which history it is: a variable that changes type starts a new one. */
  readonly source: number;

  /** Grows with every change to the history. */
  readonly version: number;

  /** Grows with every change that is not an append at the end. */
  readonly rewrite: number;

  /** The time of the last sample then. */
  readonly tailUs: number;
}

/**
 * A run as a recording remembers it, with the names its variables had.
 */
export interface RecordedRun {
  /** The session's id for the run. */
  readonly runId: number;

  /** Where the robot keeps the stream; a new stream in a slot replaces the one there. */
  readonly slot: number;

  /** The variables of each sample, in wire order. */
  readonly variables: readonly HistoryVariable[];
}

/**
 * One variable of a stream, in the order its values arrive in each sample; its name is taken from
 * the schema when left out.
 */
export type VariableSpec = Omit<HistoryVariable, 'name'> & { readonly name?: string };

/**
 * A stream the source opened: a layout of variables sampled together, from the moment the robot
 * starts sending it until it stops. Its run id is unique for the whole session.
 */
export type StreamRunSpec = Omit<RecordedRun, 'variables'> & {
  readonly variables: readonly VariableSpec[];
};

/**
 * Samples missing inside a run, before the sample stored at {@link RunGap.index}.
 */
export interface RunGap {
  /** Whether they never arrived or were not kept. */
  readonly kind: 'dropped' | 'not-stored';

  /** The run sample index of the first stored sample after the gap. */
  index: number;

  /** How many samples are missing. */
  count: number;

  /** Where the gap starts: the last sample before it, or the first sample not kept. */
  readonly startUs: number;

  /** The time of the last sample kept before the gap, or NaN if there is none. */
  readonly afterUs: number;

  /** The time of the first sample kept after the gap, or NaN until it arrives. */
  untilUs: number;
}

/**
 * A gap as a recording remembers it, with its run.
 */
export type RecordedGap = Readonly<RunGap> & { readonly runId: number };

/**
 * A value that is not part of a stored stream, such as a READ answer or a blob, as a recording
 * remembers it.
 */
export interface RecordedValue {
  /** The variable's id in the schema at the time. */
  readonly variableId: number;

  /** Its name. */
  readonly name: string;

  /** When it was sampled, or NaN if unknown. */
  readonly timeUs: number;

  /** The value. */
  readonly value: Value;
}

/**
 * One record of a recording: a block of samples, or what a recorder writes besides the blocks,
 * each written once it is final.
 */
export type RecordingRecord =
  | { readonly kind: 'run'; readonly run: RecordedRun }
  | { readonly kind: 'run-closed'; readonly runId: number }
  | { readonly kind: 'block'; readonly block: BlockData }
  | { readonly kind: 'gap'; readonly gap: RecordedGap }
  | { readonly kind: 'boundary'; readonly boundary: Boundary }
  | { readonly kind: 'value'; readonly value: RecordedValue };

/**
 * Something the application should tell the user about: what the memory cap did, which the
 * recordings show, and the problems the monitor logs.
 */
export type StoreWarning =
  | { readonly type: 'memory-warning'; readonly usedBytes: number; readonly capBytes: number }
  | {
      readonly type: 'history-dropped';
      readonly untilUs: number;
      readonly usedBytes: number;
      readonly capBytes: number;
    }
  | { readonly type: 'history-stopped'; readonly usedBytes: number; readonly capBytes: number }
  | { readonly type: 'history-resumed' }
  | HistoryProblem;

/**
 * The store as a whole, for the memory gauge and the recording indicator.
 */
export interface StoreStatus {
  /** Bytes held by sample blocks, their pyramids and the gap records. */
  readonly usedBytes: number;

  /** The configured cap. */
  readonly capBytes: number;

  /** Whether new samples stopped being kept, which only happens while recording. */
  readonly historyStopped: boolean;

  /** Whether blocks are being written to a persistence layer. */
  readonly recording: boolean;

  /** Whether writes to the persistence layer are failing. */
  readonly persistenceFailing: boolean;

  /** Blocks whose samples are in memory. */
  readonly residentBlocks: number;

  /** Blocks whose samples were evicted and live only in the persistence layer. */
  readonly evictedBlocks: number;
}
