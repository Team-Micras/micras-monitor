import { allocateColumn, bytesPerValue, type ColumnKind } from './columns';
import type { NumericColumn } from './types';

const LEAF_SHIFT = 4;
const LEAF_MASK = (1 << LEAF_SHIFT) - 1;
const FANOUT_SHIFT = 2;
const FANOUT_MASK = (1 << FANOUT_SHIFT) - 1;

/** How many samples the finest level of the pyramid summarises per entry. */
export const LEAF_SIZE = 1 << LEAF_SHIFT;

/** How many entries of one level each entry of the next level summarises. */
export const FANOUT = 1 << FANOUT_SHIFT;

function levelSizes(samples: number): number[] {
  const sizes = [Math.max(1, Math.ceil(samples / LEAF_SIZE))];

  while (sizes[sizes.length - 1] > 1) {
    sizes.push(Math.ceil(sizes[sizes.length - 1] / FANOUT));
  }

  return sizes;
}

/**
 * Collects the minimum and maximum of the numbers in a range, and whether any NaN was in it.
 *
 * It also counts what it read, raw samples and pyramid entries apart, so that tests can check
 * what a query costs.
 */
export class MinMaxAccumulator {
  /** The smallest number seen, or +∞ if none. */
  min = Number.POSITIVE_INFINITY;

  /** The largest number seen, or −∞ if none. */
  max = Number.NEGATIVE_INFINITY;

  /** Whether a NaN was seen. */
  nan = false;

  /** Raw samples read since the accumulator was made. */
  rawSamples = 0;

  /** Pyramid entries read since the accumulator was made. */
  pyramidEntries = 0;

  /** Forget the range, keeping the counters. */
  clear(): void {
    this.min = Number.POSITIVE_INFINITY;
    this.max = Number.NEGATIVE_INFINITY;
    this.nan = false;
  }

  /** Whether any value other than NaN was seen. */
  get hasValue(): boolean {
    return this.min <= this.max;
  }

  /** Take raw samples `[start, end)` of a column into account. */
  addRaw(values: NumericColumn, start: number, end: number): void {
    let min = this.min;
    let max = this.max;
    let nan = this.nan;

    for (let index = start; index < end; index++) {
      const value = values[index];

      if (value !== value) {
        nan = true;
      } else {
        if (value < min) {
          min = value;
        }

        if (value > max) {
          max = value;
        }
      }
    }

    this.min = min;
    this.max = max;
    this.nan = nan;
    this.rawSamples += end - start;
  }

  /** Take one pyramid entry into account. */
  addEntry(min: number, max: number, nan: number): void {
    this.pyramidEntries++;

    if (nan !== 0) {
      this.nan = true;
    }

    if (min < this.min) {
      this.min = min;
    }

    if (max > this.max) {
      this.max = max;
    }
  }
}

/**
 * The minimum and maximum of one column of a block, at every power of four from 16 samples up
 * to the whole block.
 *
 * It is filled as samples arrive, one comparison per sample for the finest level and one per
 * completed entry above it, so it is never rebuilt. The bounds of an entry are those of its
 * numbers; a separate marker says whether it also covers a NaN, so that a stray NaN hides
 * nothing around it.
 *
 * A range of `n` entries is covered by at most `2·(FANOUT − 1)` entries per level, which is what
 * makes a whole-history query cost the number of pixels times the number of levels instead of
 * the number of samples.
 */
export class MinMaxPyramid {
  private mins: NumericColumn[] = [];
  private maxs: NumericColumn[] = [];
  private nans: Uint8Array[] = [];
  private count = 0;
  private sealed = false;

  /**
   * @param kind The kind of the column it summarises, so that 64 bit values keep their precision.
   * @param capacity How many samples the block holds; a power of two, at least {@link LEAF_SIZE}.
   */
  constructor(kind: ColumnKind, capacity: number) {
    for (const entries of levelSizes(capacity)) {
      this.mins.push(allocateColumn(kind, entries));
      this.maxs.push(allocateColumn(kind, entries));
      this.nans.push(new Uint8Array(entries));
    }
  }

  /**
   * The memory a pyramid takes, without making one.
   *
   * @param kind The kind of the column it would summarise.
   * @param samples How many samples it would summarise.
   */
  static byteLengthFor(kind: ColumnKind, samples: number): number {
    let entries = 0;

    for (const size of levelSizes(samples)) {
      entries += size;
    }

    return entries * (2 * bytesPerValue(kind) + 1);
  }

  /** How many levels the pyramid has. */
  get levels(): number {
    return this.mins.length;
  }

  /** How many samples it summarises. */
  get length(): number {
    return this.count;
  }

  /** The memory its levels take. */
  get byteLength(): number {
    let bytes = 0;

    for (let level = 0; level < this.mins.length; level++) {
      bytes += this.mins[level].byteLength + this.maxs[level].byteLength;
      bytes += this.nans[level].byteLength;
    }

    return bytes;
  }

  /**
   * Add the next sample of the column.
   *
   * @param value The value as stored in the column.
   */
  push(value: number): void {
    const index = this.count++;
    const leaf = index >> LEAF_SHIFT;

    if ((index & LEAF_MASK) === 0) {
      this.mins[0][leaf] = Number.POSITIVE_INFINITY;
      this.maxs[0][leaf] = Number.NEGATIVE_INFINITY;
      this.nans[0][leaf] = 0;
    }

    if (value !== value) {
      this.nans[0][leaf] = 1;
    } else {
      if (value < this.mins[0][leaf]) {
        this.mins[0][leaf] = value;
      }

      if (value > this.maxs[0][leaf]) {
        this.maxs[0][leaf] = value;
      }
    }

    if ((index & LEAF_MASK) === LEAF_MASK) {
      this.fold(0, leaf);
    }
  }

  /**
   * Complete the entries the last, partial leaf left open. Called once no more samples will come,
   * so that the pyramid alone can answer for the whole block.
   */
  seal(): void {
    if (this.sealed) {
      return;
    }

    this.sealed = true;
    let size = LEAF_SIZE;
    let entries = Math.ceil(this.count / LEAF_SIZE);

    for (let level = 0; level + 1 < this.mins.length && entries > 0; level++) {
      const last = entries - 1;

      if (this.count % size !== 0) {
        this.merge(level, last, (last & FANOUT_MASK) === 0);
      }

      size <<= FANOUT_SHIFT;
      entries = (last >> FANOUT_SHIFT) + 1;
    }
  }

  /**
   * Shrink every level to the entries the samples use, once sealed: a block sealed early, before
   * it filled, gives back the rest of its memory.
   */
  compact(): void {
    const sizes = levelSizes(this.count);
    const size = (level: number) => sizes[Math.min(level, sizes.length - 1)];
    this.mins = this.mins.map((entries, level) => entries.slice(0, size(level)));
    this.maxs = this.maxs.map((entries, level) => entries.slice(0, size(level)));
    this.nans = this.nans.map((entries, level) => entries.slice(0, size(level)));
  }

  /**
   * Add the exact bounds of samples `[start, end)` to an accumulator, reading the raw column only
   * for the samples at either end that do not fill a whole leaf.
   *
   * @param values The raw column the pyramid summarises.
   * @param start The first sample.
   * @param end One past the last sample; no more than {@link length}.
   * @param into Where the bounds go.
   */
  addSamples(values: NumericColumn, start: number, end: number, into: MinMaxAccumulator): void {
    const firstLeaf = (start + LEAF_MASK) >> LEAF_SHIFT;
    const endLeaf = end >> LEAF_SHIFT;

    if (firstLeaf >= endLeaf) {
      into.addRaw(values, start, end);
      return;
    }

    into.addRaw(values, start, firstLeaf << LEAF_SHIFT);
    into.addRaw(values, endLeaf << LEAF_SHIFT, end);
    this.addLeaves(firstLeaf, endLeaf, into);
  }

  /**
   * Add the bounds of leaves `[first, end)` to an accumulator without touching raw samples.
   *
   * Every leaf in the range must be complete, or the pyramid sealed.
   *
   * @param first The first leaf.
   * @param end One past the last leaf.
   * @param into Where the bounds go.
   */
  addLeaves(first: number, end: number, into: MinMaxAccumulator): void {
    const top = this.mins.length - 1;
    let low = first;
    let high = end;

    for (let level = 0; low < high; level++) {
      const mins = this.mins[level];
      const maxs = this.maxs[level];
      const nans = this.nans[level];

      if (level === top) {
        for (let entry = low; entry < high; entry++) {
          into.addEntry(mins[entry], maxs[entry], nans[entry]);
        }

        return;
      }

      while (low < high && (low & FANOUT_MASK) !== 0) {
        into.addEntry(mins[low], maxs[low], nans[low]);
        low++;
      }

      while (low < high && (high & FANOUT_MASK) !== 0) {
        high--;
        into.addEntry(mins[high], maxs[high], nans[high]);
      }

      low >>= FANOUT_SHIFT;
      high >>= FANOUT_SHIFT;
    }
  }

  private fold(level: number, entry: number): void {
    if (level + 1 >= this.mins.length) {
      return;
    }

    this.merge(level, entry, (entry & FANOUT_MASK) === 0);

    if ((entry & FANOUT_MASK) === FANOUT_MASK) {
      this.fold(level + 1, entry >> FANOUT_SHIFT);
    }
  }

  private merge(level: number, entry: number, first: boolean): void {
    const parent = entry >> FANOUT_SHIFT;
    const mins = this.mins[level + 1];
    const maxs = this.maxs[level + 1];
    const nans = this.nans[level + 1];
    const min = this.mins[level][entry];
    const max = this.maxs[level][entry];
    const nan = this.nans[level][entry];

    if (first) {
      mins[parent] = min;
      maxs[parent] = max;
      nans[parent] = nan;
      return;
    }

    if (min < mins[parent]) {
      mins[parent] = min;
    }

    if (max > maxs[parent]) {
      maxs[parent] = max;
    }

    nans[parent] |= nan;
  }
}
