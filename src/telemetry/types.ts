import type { TypeCode } from '@/protocol';

/**
 * A value as the link decodes it: numbers, booleans and 64 bit integers from the stream or a READ,
 * bytes for a blob.
 */
export type TelemetryValue = number | bigint | boolean | string | Uint8Array;

/**
 * A column of stored values: 32 bit floats for the narrow types, 64 bit floats for the rest.
 */
export type NumericColumn = Float32Array | Float64Array;

/**
 * One variable of a stream group, in the order its values arrive in each sample.
 */
export interface VariableSpec {
  /** The variable's id in the schema. */
  readonly id: number;

  /** Its type, as the schema states it. */
  readonly type: TypeCode;
}

/**
 * A group layout the robot acknowledged. Every definition of a group starts a new epoch, because
 * the robot restarts the sequence numbers of the group.
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
 * Why the link lost track of the robot.
 */
export type BoundaryKind = 'reconnect' | 'reboot';

/**
 * A moment where the link lost track of the robot. No line is drawn across it.
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
 * - `dropped`: it was in a group, and the sequence numbers show samples that never arrived.
 * - `not-stored`: they arrived, but the memory cap stopped the store from keeping them.
 */
export type GapKind = 'not-streamed' | 'dropped' | 'not-stored';

/**
 * A stretch of a variable's history with no samples.
 */
export interface Gap {
  /** Why there are no samples. */
  readonly kind: GapKind;

  /** The time of the last sample before the gap. */
  readonly startUs: number;

  /** The time of the first sample after it, or NaN if none arrived yet. */
  readonly endUs: number;

  /** How many samples are missing, when the sequence numbers tell (dropped and not stored). */
  readonly count?: number;
}

/**
 * The most recent value of a variable.
 */
export interface LatestValue {
  /** The value as it was decoded, so 64 bit integers keep every bit. */
  readonly value: TelemetryValue;

  /** When the robot sampled it, if known; a READ answer carries no timestamp. */
  readonly timeUs: number | undefined;
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
 * Something the application should tell the user about.
 */
export type TelemetryEvent =
  | { readonly type: 'memory-warning'; readonly usedBytes: number; readonly capBytes: number }
  | { readonly type: 'history-stopped'; readonly usedBytes: number; readonly capBytes: number }
  | { readonly type: 'history-resumed' }
  | { readonly type: 'precision-loss'; readonly variableId: number }
  | { readonly type: 'persistence-error'; readonly error: unknown };

/**
 * The store as a whole, for the memory gauge and the recording indicator.
 */
export interface StoreStatus {
  /** Bytes held by sample blocks and their pyramids. */
  readonly usedBytes: number;

  /** The configured cap. */
  readonly capBytes: number;

  /** Whether new samples stopped being kept because the cap was reached. */
  readonly historyStopped: boolean;

  /** Whether blocks are being written to a persistence layer. */
  readonly recording: boolean;

  /** Blocks whose samples are in memory. */
  readonly residentBlocks: number;

  /** Blocks whose samples were evicted and live only in the persistence layer. */
  readonly evictedBlocks: number;
}
