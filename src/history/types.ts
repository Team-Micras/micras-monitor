import type { Value, ValueType, Variable } from '@/core/variables';

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
 * One variable of a stream group, in the order its values arrive in each sample.
 */
export interface VariableSpec {
  /** The variable's id in the schema. */
  readonly id: number;

  /** Its type, as the schema states it. */
  readonly type: ValueType;

  /** Its name; taken from the schema when left out. */
  readonly name?: string;
}

/**
 * A stream the source opened: a layout of variables sampled together, from the moment the robot
 * starts sending it until it stops.
 */
export interface EpochSpec {
  /** Unique for the whole session; the session picks it. */
  readonly epochId: number;

  /** The robot's group slot. */
  readonly groupId: number;

  /** The variables in each sample, in wire order. */
  readonly variables: readonly VariableSpec[];
}

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
 * - `not-streamed`: the variable was in no group at the time.
 * - `dropped`: it was in a group, and the source lost samples it knows the robot took.
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
  /** The epoch the samples belong to. */
  readonly epochId: number;

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
 * An epoch as a recording remembers it, with the names its variables had.
 */
export interface RecordedEpoch {
  /** The session's id for the epoch. */
  readonly epochId: number;

  /** The robot's group slot. */
  readonly groupId: number;

  /** The variables of each sample, in wire order. */
  readonly variables: readonly HistoryVariable[];
}

/**
 * Samples missing inside an epoch, as a recording remembers them.
 */
export interface RecordedGap {
  /** The epoch. */
  readonly epochId: number;

  /** Whether the samples never arrived or were not kept. */
  readonly kind: 'dropped' | 'not-stored';

  /** The epoch sample index of the first stored sample after the gap. */
  readonly index: number;

  /** How many samples are missing. */
  readonly count: number;

  /** Where the gap starts. */
  readonly startUs: number;

  /** The time of the last sample kept before the gap, or NaN. */
  readonly afterUs: number;

  /** The time of the first sample kept after the gap, or NaN. */
  readonly untilUs: number;
}

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
 * What a recorder needs to know besides the blocks, each told once it is final.
 */
export type IngestionEvent =
  | { readonly type: 'epoch-opened'; readonly epoch: RecordedEpoch }
  | { readonly type: 'epoch-closed'; readonly epochId: number }
  | { readonly type: 'gap'; readonly gap: RecordedGap }
  | { readonly type: 'boundary'; readonly boundary: Boundary }
  | { readonly type: 'value'; readonly value: RecordedValue };

/**
 * Something the application should tell the user about.
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
  | { readonly type: 'precision-loss'; readonly name: string }
  | { readonly type: 'persistence-error'; readonly error: unknown }
  | { readonly type: 'persistence-recovered' }
  | {
      readonly type: 'time-backwards';
      readonly epochId: number;
      readonly timeUs: number;
      readonly lastUs: number;
    };

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
