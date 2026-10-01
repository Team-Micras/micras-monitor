import type { BlockBacking, BlockRef, BlockData } from './block-backing';
import { allocateColumn, bytesPerValue, type ColumnKind, kindOfColumn } from './columns';
import { LEAF_SIZE, MinMaxPyramid } from './min-max-pyramid';
import type { NumericColumn } from './types';

/**
 * The shape of a block: its place in the run and what it stores.
 */
export interface BlockLayout {
  /** Which block it is. */
  readonly ref: BlockRef;

  /** The run sample index of its first sample. */
  readonly startSample: number;

  /** How many samples it holds when full. */
  readonly capacity: number;

  /** The ids of the run's numeric variables, one per column. */
  readonly variableIds: readonly number[];

  /** How each column is stored. */
  readonly kinds: readonly ColumnKind[];
}

/**
 * Whether the columns of a persisted block are the given ones, in order, each as long as its
 * time column.
 *
 * @param data The persisted block.
 * @param variableIds The id of each column.
 * @param kinds How each column is stored.
 */
export function fitsColumns(
  data: BlockData,
  variableIds: readonly number[],
  kinds: readonly ColumnKind[]
): boolean {
  return (
    data.columns.length === variableIds.length &&
    data.columns.every(
      (column, index) =>
        column.variableId === variableIds[index] &&
        kindOfColumn(column.values) === kinds[index] &&
        column.values.length === data.time.length
    )
  );
}

/**
 * A fixed-size chunk of a run: a time column, one value column per numeric variable, and a
 * min/max pyramid per column.
 *
 * Its arrays are allocated once, at full size, and never grow, so a view handed out stays valid.
 * A block sealed before it filled, as recording does every few seconds, is compacted once to the
 * samples it holds; the views handed out before keep the old arrays, which are never written
 * again. Once sealed, its raw columns may be evicted to a persistence layer and brought back; the
 * pyramids and the time of each pyramid leaf stay in memory, so a coarse query never needs the
 * raw samples.
 */
export class Block {
  /** Which block it is. */
  readonly ref: BlockRef;

  /** The run sample index of its first sample. */
  readonly startSample: number;

  /** How many samples it holds when full. */
  readonly capacity: number;

  /** The ids of the run's numeric variables, one per column. */
  readonly variableIds: readonly number[];

  /** How each column is stored. */
  readonly kinds: readonly ColumnKind[];

  /** One pyramid per column. */
  readonly pyramids: readonly MinMaxPyramid[];

  /** The time of its first sample, or NaN while empty. */
  firstTimeUs = Number.NaN;

  /** The time of its last sample, or NaN while empty. */
  lastTimeUs = Number.NaN;

  /**
   * The persistence layer the block was last written to, or the recording it was loaded from:
   * where a whole copy of it can be read back from.
   */
  copy: BlockBacking | undefined;

  /** Whether a write to a persistence layer is under way. */
  writing = false;

  /** Whether a read from the persistence layer is under way. */
  loading = false;

  /** The last query tick that read the block's raw samples, for eviction. */
  lastUsed = 0;

  #time: Float64Array | null;
  #columns: NumericColumn[] | null;
  #leafTimes: Float64Array;
  #length = 0;
  #sealed = false;

  /**
   * @param layout What the block holds.
   */
  constructor(layout: BlockLayout) {
    this.ref = layout.ref;
    this.startSample = layout.startSample;
    this.capacity = layout.capacity;
    this.variableIds = layout.variableIds;
    this.kinds = layout.kinds;
    this.#time = new Float64Array(layout.capacity);
    this.#columns = layout.kinds.map((kind) => allocateColumn(kind, layout.capacity));
    this.pyramids = layout.kinds.map((kind) => new MinMaxPyramid(kind, layout.capacity));
    this.#leafTimes = new Float64Array(Math.ceil(layout.capacity / LEAF_SIZE));
  }

  /**
   * The memory a block with this layout takes when resident, without making one.
   */
  static byteLengthFor(layout: Pick<BlockLayout, 'capacity' | 'kinds'>): number {
    let bytes = layout.capacity * 8 + Math.ceil(layout.capacity / LEAF_SIZE) * 8;

    for (const kind of layout.kinds) {
      bytes += layout.capacity * bytesPerValue(kind);
      bytes += MinMaxPyramid.byteLengthFor(kind, layout.capacity);
    }

    return bytes;
  }

  /** The time of the first sample of each pyramid leaf; stays in memory when the block is evicted. */
  get leafTimes(): Float64Array {
    return this.#leafTimes;
  }

  /** How many samples it holds. */
  get length(): number {
    return this.#length;
  }

  /** Whether it holds as many samples as it can. */
  get full(): boolean {
    return this.#length === this.capacity;
  }

  /** Whether no more samples will be added. */
  get sealed(): boolean {
    return this.#sealed;
  }

  /** Whether its raw samples are in memory. */
  get resident(): boolean {
    return this.#time !== null;
  }

  /** The time column while resident; its first {@link length} entries are samples. */
  get time(): Float64Array | null {
    return this.#time;
  }

  /** The value columns while resident, in the order of {@link variableIds}. */
  get columns(): readonly NumericColumn[] | null {
    return this.#columns;
  }

  /** The memory taken by the raw columns, which eviction gives back. */
  get rawByteLength(): number {
    if (!this.#time || !this.#columns) {
      return 0;
    }

    let bytes = this.#time.byteLength;

    for (const column of this.#columns) {
      bytes += column.byteLength;
    }

    return bytes;
  }

  /** The memory the raw columns take once brought back, sized to the samples held. */
  get restoredByteLength(): number {
    let bytes = 8 * this.#length;

    for (const kind of this.kinds) {
      bytes += this.#length * bytesPerValue(kind);
    }

    return bytes;
  }

  /** The memory taken by what never leaves: the pyramids and the leaf times. */
  get indexByteLength(): number {
    let bytes = this.#leafTimes.byteLength;

    for (const pyramid of this.pyramids) {
      bytes += pyramid.byteLength;
    }

    return bytes;
  }

  /**
   * Add a sample. The block must be resident, not full and not sealed.
   *
   * @param timeUs When the sample was taken.
   * @param row Its values, one per column.
   */
  append(timeUs: number, row: ArrayLike<number>): void {
    const time = this.#time;
    const columns = this.#columns;

    if (!time || !columns || this.#sealed || this.#length === this.capacity) {
      throw new Error(`Block ${this.ref.index} of run ${this.ref.runId} takes no samples`);
    }

    const index = this.#length++;
    time[index] = timeUs;

    if (index % LEAF_SIZE === 0) {
      this.#leafTimes[index / LEAF_SIZE] = timeUs;
    }

    for (let column = 0; column < columns.length; column++) {
      const values = columns[column];
      values[index] = row[column];
      this.pyramids[column].push(values[index]);
    }

    if (index === 0) {
      this.firstTimeUs = timeUs;
    }

    this.lastTimeUs = timeUs;
  }

  /** Take no more samples, and complete the pyramids so they answer for the whole block. */
  seal(): void {
    this.#sealed = true;

    for (const pyramid of this.pyramids) {
      pyramid.seal();
    }
  }

  /**
   * Shrink a block sealed before it filled to the samples it holds.
   *
   * @returns The bytes given back.
   */
  compact(): number {
    if (!this.#sealed || this.#length === this.capacity) {
      return 0;
    }

    const before = this.rawByteLength + this.indexByteLength;
    this.#time = this.#time?.slice(0, this.#length) ?? null;
    this.#columns = this.#columns?.map((values) => values.slice(0, this.#length)) ?? null;
    this.#leafTimes = this.#leafTimes.slice(0, Math.max(1, Math.ceil(this.#length / LEAF_SIZE)));

    for (const pyramid of this.pyramids) {
      pyramid.compact();
    }

    return before - this.rawByteLength - this.indexByteLength;
  }

  /**
   * The raw samples, as views, for a persistence layer.
   */
  toPersisted(): BlockData {
    const time = this.#time;
    const columns = this.#columns;

    if (!time || !columns) {
      throw new Error(`Block ${this.ref.index} of run ${this.ref.runId} is not in memory`);
    }

    return {
      ref: this.ref,
      startSample: this.startSample,
      time: time.subarray(0, this.#length),
      columns: columns.map((values, column) => ({
        variableId: this.variableIds[column],
        values: values.subarray(0, this.#length),
      })),
    };
  }

  /**
   * Let go of the raw columns.
   *
   * @returns The bytes given back.
   */
  evict(): number {
    const bytes = this.rawByteLength;
    this.#time = null;
    this.#columns = null;
    return bytes;
  }

  /**
   * Take the raw columns back from a persisted copy.
   *
   * @param persisted What the persistence layer returned for this block, with arrays of exactly
   *   {@link length} entries.
   * @returns The bytes taken.
   * @throws If the copy does not match the block.
   */
  restore(persisted: BlockData): number {
    const matches =
      persisted.ref.runId === this.ref.runId &&
      persisted.ref.index === this.ref.index &&
      persisted.startSample === this.startSample &&
      persisted.time.length === this.#length &&
      fitsColumns(persisted, this.variableIds, this.kinds);

    if (!matches) {
      throw new Error(`Persisted block ${this.ref.index} of run ${this.ref.runId} differs`);
    }

    this.#time = persisted.time;
    this.#columns = persisted.columns.map((column) => column.values);
    return this.rawByteLength;
  }
}
