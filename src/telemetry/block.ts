import type { BlockPersistence, BlockRef, PersistedBlock } from './persistence';
import { LEAF_SIZE, MinMaxPyramid } from './pyramid';
import { allocateColumn, bytesPerValue, type ColumnKind, kindOfColumn } from './storage';
import type { NumericColumn } from './types';

/**
 * The shape of a block: its place in the epoch and what it stores.
 */
export interface BlockLayout {
  /** Which block it is. */
  readonly ref: BlockRef;

  /** The epoch sample index of its first sample. */
  readonly startSample: number;

  /** How many samples it holds when full. */
  readonly capacity: number;

  /** The ids of the epoch's numeric variables, one per column. */
  readonly variableIds: readonly number[];

  /** How each column is stored. */
  readonly kinds: readonly ColumnKind[];
}

/**
 * A fixed-size chunk of an epoch: a time column, one value column per numeric variable, and a
 * min/max pyramid per column.
 *
 * Its arrays are allocated once, at full size, and never grow, so a view handed out stays valid
 * for as long as the block is resident. Once sealed, its raw columns may be evicted to a
 * persistence layer and brought back; the pyramids and the time of each pyramid leaf stay in
 * memory, so a coarse query never needs the raw samples.
 */
export class Block {
  /** Which block it is. */
  readonly ref: BlockRef;

  /** The epoch sample index of its first sample. */
  readonly startSample: number;

  /** How many samples it holds when full. */
  readonly capacity: number;

  /** The ids of the epoch's numeric variables, one per column. */
  readonly variableIds: readonly number[];

  /** How each column is stored. */
  readonly kinds: readonly ColumnKind[];

  /** One pyramid per column. */
  readonly pyramids: readonly MinMaxPyramid[];

  /** The time of the first sample of each pyramid leaf; stays in memory when the block is evicted. */
  readonly leafTimes: Float64Array;

  /** The time of its first sample, or NaN while empty. */
  firstTimeUs = Number.NaN;

  /** The time of its last sample, or NaN while empty. */
  lastTimeUs = Number.NaN;

  /** Where the block was written, once the write finished. */
  persistedTo: BlockPersistence | undefined;

  /** Whether a write to a persistence layer is under way. */
  writing = false;

  /** Whether a read from the persistence layer is under way. */
  loading = false;

  /** The last query tick that read the block's raw samples, for eviction. */
  lastUsed = 0;

  private timeColumn: Float64Array | null;
  private valueColumns: NumericColumn[] | null;
  private count = 0;
  private isSealed = false;

  /**
   * @param layout What the block holds.
   */
  constructor(layout: BlockLayout) {
    this.ref = layout.ref;
    this.startSample = layout.startSample;
    this.capacity = layout.capacity;
    this.variableIds = layout.variableIds;
    this.kinds = layout.kinds;
    this.timeColumn = new Float64Array(layout.capacity);
    this.valueColumns = layout.kinds.map((kind) => allocateColumn(kind, layout.capacity));
    this.pyramids = layout.kinds.map((kind) => new MinMaxPyramid(kind, layout.capacity));
    this.leafTimes = new Float64Array(Math.ceil(layout.capacity / LEAF_SIZE));
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

  /** How many samples it holds. */
  get length(): number {
    return this.count;
  }

  /** Whether it holds as many samples as it can. */
  get full(): boolean {
    return this.count === this.capacity;
  }

  /** Whether no more samples will be added. */
  get sealed(): boolean {
    return this.isSealed;
  }

  /** Whether its raw samples are in memory. */
  get resident(): boolean {
    return this.timeColumn !== null;
  }

  /** The time column while resident; its first {@link length} entries are samples. */
  get time(): Float64Array | null {
    return this.timeColumn;
  }

  /** The value columns while resident, in the order of {@link variableIds}. */
  get columns(): readonly NumericColumn[] | null {
    return this.valueColumns;
  }

  /** The memory taken by the raw columns, which eviction gives back. */
  get rawByteLength(): number {
    if (!this.timeColumn || !this.valueColumns) {
      return 0;
    }

    let bytes = this.timeColumn.byteLength;

    for (const column of this.valueColumns) {
      bytes += column.byteLength;
    }

    return bytes;
  }

  /** The memory the raw columns take once brought back, sized to the samples held. */
  get restoredByteLength(): number {
    let bytes = 8 * this.count;

    for (const kind of this.kinds) {
      bytes += this.count * bytesPerValue(kind);
    }

    return bytes;
  }

  /** The memory taken by what never leaves: the pyramids and the leaf times. */
  get indexByteLength(): number {
    let bytes = this.leafTimes.byteLength;

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
    const time = this.timeColumn;
    const columns = this.valueColumns;

    if (!time || !columns || this.isSealed || this.count === this.capacity) {
      throw new Error(`Block ${this.ref.index} of epoch ${this.ref.epochId} takes no samples`);
    }

    const index = this.count++;
    time[index] = timeUs;

    if (index % LEAF_SIZE === 0) {
      this.leafTimes[index / LEAF_SIZE] = timeUs;
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
    this.isSealed = true;

    for (const pyramid of this.pyramids) {
      pyramid.seal();
    }
  }

  /**
   * The raw samples, as views, for a persistence layer.
   */
  toPersisted(): PersistedBlock {
    const time = this.timeColumn;
    const columns = this.valueColumns;

    if (!time || !columns) {
      throw new Error(`Block ${this.ref.index} of epoch ${this.ref.epochId} is not in memory`);
    }

    return {
      ref: this.ref,
      startSample: this.startSample,
      time: time.subarray(0, this.count),
      columns: columns.map((values, column) => ({
        variableId: this.variableIds[column],
        values: values.subarray(0, this.count),
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
    this.timeColumn = null;
    this.valueColumns = null;
    return bytes;
  }

  /**
   * Take the raw columns back from a persisted copy.
   *
   * @param persisted What the persistence layer returned for this block.
   * @returns The bytes taken.
   * @throws If the copy does not match the block.
   */
  restore(persisted: PersistedBlock): number {
    const matches =
      persisted.ref.epochId === this.ref.epochId &&
      persisted.ref.index === this.ref.index &&
      persisted.startSample === this.startSample &&
      persisted.time.length === this.count &&
      persisted.columns.length === this.pyramids.length &&
      persisted.columns.every(
        (column, index) =>
          column.variableId === this.variableIds[index] &&
          column.values.length === this.count &&
          kindOfColumn(column.values) === this.kinds[index]
      );

    if (!matches) {
      throw new Error(`Persisted block ${this.ref.index} of epoch ${this.ref.epochId} differs`);
    }

    this.timeColumn = persisted.time;
    this.valueColumns = persisted.columns.map((column) => column.values);
    return this.rawByteLength;
  }
}
