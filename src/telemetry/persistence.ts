import type {
  Boundary,
  NumericColumn,
  RecordedEpoch,
  RecordedGap,
  RecordedValue,
  HistoryVariable,
} from './types';

/**
 * Which block a persisted block is: its epoch, and its position in the epoch.
 */
export interface BlockRef {
  /** The epoch the block belongs to. */
  readonly epochId: number;

  /** The block's position among the epoch's blocks, from 0. */
  readonly index: number;
}

/**
 * The values of one variable in a persisted block.
 */
export interface PersistedColumn {
  /** The variable's id in the schema. */
  readonly variableId: number;

  /** One value per sample of the block. */
  readonly values: NumericColumn;
}

/**
 * The raw samples of a sealed block, as they leave and come back from a persistence layer.
 *
 * The pyramid of a block never leaves memory, so it is not part of it.
 */
export interface PersistedBlock {
  /** Which block this is. */
  readonly ref: BlockRef;

  /** The epoch sample index of the block's first sample. */
  readonly startSample: number;

  /** The sample times; its length is the number of samples. */
  readonly time: Float64Array;

  /** One column per numeric variable of the epoch. */
  readonly columns: readonly PersistedColumn[];
}

/**
 * Where sealed blocks go while recording, so that they can leave memory and come back when a
 * query needs them.
 *
 * The application implements it over OPFS; an in-memory one stands in for tests.
 */
export interface BlockPersistence {
  /**
   * Store a sealed block. The arrays may be views into the store's memory: copy what must outlive
   * the returned promise.
   */
  write(block: PersistedBlock): Promise<void>;

  /**
   * Bring back a block written before. The arrays must hold exactly the block's samples, no more:
   * the store counts their size against its memory cap, and keeps them.
   *
   * @throws If no block with that reference was written.
   */
  read(ref: BlockRef): Promise<PersistedBlock>;
}

/**
 * An epoch of a saved session, as `TelemetryStore.load` takes it.
 */
export interface StoredEpoch {
  /** The epoch, with the names its variables had. */
  readonly epoch: RecordedEpoch;

  /** Its gaps, in the order they were written; a later one with the same start replaces one before. */
  readonly gaps: readonly RecordedGap[];

  /** Its blocks, in index order; decoded one at a time as they are taken. */
  readonly blocks: Iterable<PersistedBlock>;
}

/**
 * A saved session, as `TelemetryStore.load` takes it.
 */
export interface StoredSession {
  /** The robot's schema when the session was recorded. */
  readonly schema: readonly HistoryVariable[];

  /** Every epoch, in the order they opened. */
  readonly epochs: readonly StoredEpoch[];

  /** Every boundary. */
  readonly boundaries: readonly Boundary[];

  /** The values outside the stored streams, in the order they came. */
  readonly values: readonly RecordedValue[];
}
