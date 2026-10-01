import type { NumericColumn } from './types';

/**
 * Which block a persisted block is: its run, and its position in the run.
 */
export interface BlockRef {
  /** The run the block belongs to. */
  readonly runId: number;

  /** The block's position among the run's blocks, from 0. */
  readonly index: number;
}

/**
 * The key of a block reference in a map.
 */
export function blockKey(ref: BlockRef): string {
  return `${ref.runId}:${ref.index}`;
}

/**
 * The values of one variable in a persisted block.
 */
export interface ColumnData {
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
export interface BlockData {
  /** Which block this is. */
  readonly ref: BlockRef;

  /** The run sample index of the block's first sample. */
  readonly startSample: number;

  /** The sample times; its length is the number of samples. */
  readonly time: Float64Array;

  /** One column per numeric variable of the run. */
  readonly columns: readonly ColumnData[];
}

/**
 * Where sealed blocks go while recording, so that they can leave memory and come back when a
 * query needs them.
 *
 * The application implements it over OPFS; an in-memory one stands in for tests.
 */
export interface BlockBacking {
  /**
   * Store a sealed block. The arrays may be views into the store's memory: copy what must outlive
   * the returned promise.
   */
  write(block: BlockData): Promise<void>;

  /**
   * Bring back a block written before. The arrays must hold exactly the block's samples, no more:
   * the store counts their size against its memory cap, and keeps them.
   *
   * @throws If no block with that reference was written.
   */
  read(ref: BlockRef): Promise<BlockData>;
}
