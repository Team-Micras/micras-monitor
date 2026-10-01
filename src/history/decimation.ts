import type { Block } from './block';
import { LEAF_SIZE, MinMaxAccumulator } from './min-max-pyramid';
import type { Boundary, HistoryMark, RunGap } from './types';
import type { Segment } from './variable-history';

/** The column holds at least one number. */
export const COLUMN_HAS_DATA = 1;

/** The column holds a NaN, so the line breaks after it. */
export const COLUMN_HAS_NAN = 2;

/** The line breaks after the column: a run ended, samples were dropped, or the link was lost. */
export const COLUMN_BREAKS = 4;

/**
 * Below this many samples per pixel column, a resident block is scanned sample by sample instead
 * of through its pyramid: the pyramid cannot save anything once a column holds less than two
 * leaves.
 */
const DENSE_SAMPLES_PER_COLUMN = 2 * LEAF_SIZE;

/**
 * Below this many samples per pixel column, rounding a column's edges to whole pyramid leaves
 * would show, so an evicted block is asked back into memory.
 */
const RELOAD_SAMPLES_PER_COLUMN = 4 * LEAF_SIZE;

/**
 * The minimum and maximum of a variable in each pixel column of a time window, with where its
 * line breaks. Only the first {@link pixels} entries of the arrays are the result; read them, do
 * not write them.
 */
export interface Decimation {
  /** The start of the window, inclusive. */
  readonly startUs: number;

  /** The end of the window, exclusive. */
  readonly endUs: number;

  /** How many columns the window is split into. */
  readonly pixels: number;

  /** The smallest number in each column, when {@link COLUMN_HAS_DATA} is set. */
  readonly min: Float64Array;

  /** The largest number in each column, when {@link COLUMN_HAS_DATA} is set. */
  readonly max: Float64Array;

  /** What each column holds: a combination of the `COLUMN_*` flags. */
  readonly flags: Uint8Array;

  /** The column a time falls in, clamped to the window. */
  columnOf(timeUs: number): number;
}

/**
 * Builds a {@link Decimation} in place, and remembers what it was built from so that the next
 * query over the same grid only recomputes the columns that can have changed.
 */
export class DecimationBuilder implements Decimation {
  startUs = 0;
  endUs = 1;
  pixels = 0;
  min = new Float64Array(0);
  max = new Float64Array(0);
  flags = new Uint8Array(0);

  /** Columns before this one are kept from the previous query. */
  fromColumn = 0;

  /** Samples before this time cannot fall in a recomputed column. */
  scanFromUs = 0;

  /** What the result was built from, for the next query to compare with. */
  source: object | undefined;

  /** Where the source's history stood when the result was built. */
  mark: HistoryMark | undefined;

  #scale = 0;

  /**
   * Empty every column for a new window.
   *
   * @throws If the window is empty or there are no columns.
   */
  reset(startUs: number, endUs: number, pixels: number): void {
    if (!(endUs > startUs) || !Number.isInteger(pixels) || pixels < 1) {
      throw new RangeError(`Cannot split [${startUs}, ${endUs}) into ${pixels} columns`);
    }

    if (pixels > this.flags.length) {
      this.min = new Float64Array(pixels);
      this.max = new Float64Array(pixels);
      this.flags = new Uint8Array(pixels);
    }

    this.startUs = startUs;
    this.endUs = endUs;
    this.pixels = pixels;
    this.#scale = pixels / (endUs - startUs);
    this.source = undefined;
    this.mark = undefined;
    this.resetFrom(0);
  }

  /** Whether the result covers exactly this window and grid. */
  sameGrid(startUs: number, endUs: number, pixels: number): boolean {
    return this.startUs === startUs && this.endUs === endUs && this.pixels === pixels;
  }

  /** Empty the columns from one on, keeping those before it. */
  resetFrom(column: number): void {
    this.fromColumn = column;
    this.scanFromUs = Math.max(this.startUs, this.startUs + (column - 1) / this.#scale);
    this.min.fill(Number.POSITIVE_INFINITY, column, this.pixels);
    this.max.fill(Number.NEGATIVE_INFINITY, column, this.pixels);
    this.flags.fill(0, column, this.pixels);
  }

  /** {@inheritDoc Decimation.columnOf} */
  columnOf(timeUs: number): number {
    const column = Math.floor((timeUs - this.startUs) * this.#scale);
    return column < 0 ? 0 : column >= this.pixels ? this.pixels - 1 : column;
  }

  /** Whether a time falls in a column being recomputed. */
  covers(timeUs: number): boolean {
    return timeUs >= this.scanFromUs && timeUs < this.endUs;
  }

  /** Break the line after the column a time falls in. */
  breakAt(timeUs: number): void {
    if (this.covers(timeUs)) {
      this.#setFlag(this.columnOf(timeUs), COLUMN_BREAKS);
    }
  }

  /**
   * Break the line across a gap between two samples, unless both fall in the same column: a gap
   * narrower than a pixel cannot be seen, and breaking there would only fray the line.
   *
   * @param afterUs The time of the sample before the gap.
   * @param untilUs The time of the sample after it, or NaN if none arrived yet.
   */
  breakBetween(afterUs: number, untilUs: number): void {
    if (!this.covers(afterUs)) {
      return;
    }

    const column = this.columnOf(afterUs);

    if (untilUs < this.endUs && this.columnOf(untilUs) === column) {
      return;
    }

    this.#setFlag(column, COLUMN_BREAKS);
  }

  /** Take one sample into account. */
  addValue(column: number, value: number): void {
    if (column < this.fromColumn) {
      return;
    }

    if (value !== value) {
      this.flags[column] |= COLUMN_HAS_NAN;
      return;
    }

    this.flags[column] |= COLUMN_HAS_DATA;

    if (value < this.min[column]) {
      this.min[column] = value;
    }

    if (value > this.max[column]) {
      this.max[column] = value;
    }
  }

  /** Take the bounds of a range of samples into account. */
  addBounds(column: number, bounds: MinMaxAccumulator): void {
    if (column < this.fromColumn) {
      return;
    }

    if (bounds.nan) {
      this.flags[column] |= COLUMN_HAS_NAN;
    }

    if (!bounds.hasValue) {
      return;
    }

    this.flags[column] |= COLUMN_HAS_DATA;

    if (bounds.min < this.min[column]) {
      this.min[column] = bounds.min;
    }

    if (bounds.max > this.max[column]) {
      this.max[column] = bounds.max;
    }
  }

  /**
   * The first index in `[low, high)` of a sorted time array whose column is at least `column`.
   */
  firstIndexInColumn(times: Float64Array, column: number, low: number, high: number): number {
    let first = low;
    let last = high;

    while (first < last) {
      const middle = (first + last) >>> 1;

      if (this.columnOf(times[middle]) < column) {
        first = middle + 1;
      } else {
        last = middle;
      }
    }

    return first;
  }

  #setFlag(column: number, flag: number): void {
    if (column >= this.fromColumn) {
      this.flags[column] |= flag;
    }
  }
}

/**
 * What a query read, to check that its cost follows the pixels and not the history.
 */
export interface DecimationStats {
  /** Raw samples read. */
  rawSamples: number;

  /** Pyramid entries read. */
  pyramidEntries: number;
}

/**
 * How a query gets at a block's raw samples.
 */
export interface BlockAccess {
  /** Count a block as used by the current query tick. */
  markUsed(block: Block): void;

  /** Ask for an evicted block to come back once the tick ends. */
  request(block: Block): void;
}

/**
 * The first index in `[low, high)` of a sorted array whose value is at least `value`.
 */
export function lowerBound(values: Float64Array, value: number, low: number, high: number): number {
  let first = low;
  let last = high;

  while (first < last) {
    const middle = (first + last) >>> 1;

    if (values[middle] < value) {
      first = middle + 1;
    } else {
      last = middle;
    }
  }

  return first;
}

/**
 * The first index in `[low, high)` of a sorted array whose value is above `value`.
 */
export function upperBound(values: Float64Array, value: number, low: number, high: number): number {
  let first = low;
  let last = high;

  while (first < last) {
    const middle = (first + last) >>> 1;

    if (values[middle] <= value) {
      first = middle + 1;
    } else {
      last = middle;
    }
  }

  return first;
}

/**
 * The first block, of a run's blocks in time order, whose last sample is at or after a time,
 * so that a query skips the blocks before its window in a search rather than one by one. The
 * block being filled comes last and counts as reaching any time while it is empty.
 */
export function firstBlockFrom(blocks: readonly Block[], timeUs: number): number {
  let low = 0;
  let high = blocks.length;

  while (low < high) {
    const middle = (low + high) >>> 1;

    if (blocks[middle].lastTimeUs < timeUs) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }

  return low;
}

function firstGapFrom(gaps: readonly RunGap[], timeUs: number): number {
  let first = 0;
  let last = gaps.length;

  while (first < last) {
    const middle = (first + last) >>> 1;

    if (gaps[middle].afterUs >= timeUs) {
      last = middle;
    } else {
      first = middle + 1;
    }
  }

  return first;
}

function lastGapInColumn(
  into: DecimationBuilder,
  gaps: readonly RunGap[],
  column: number,
  low: number
): number {
  let first = low;
  let last = gaps.length;

  while (first < last) {
    const middle = (first + last) >>> 1;
    const afterUs = gaps[middle].afterUs;

    if (afterUs < into.endUs && into.columnOf(afterUs) <= column) {
      first = middle + 1;
    } else {
      last = middle;
    }
  }

  return first - 1;
}

function nextStart(segments: readonly Segment[], from: number): number {
  for (let index = from; index < segments.length; index++) {
    const { run, column } = segments[index];

    if (column >= 0 && run.keptCount > 0) {
      return run.firstTimeUs;
    }
  }

  return Number.NaN;
}

function decimateResident(
  into: DecimationBuilder,
  block: Block,
  column: number,
  bounds: MinMaxAccumulator
): void {
  const time = block.time;
  const columns = block.columns;

  if (!time || !columns) {
    return;
  }

  const values = columns[column];
  const first = lowerBound(time, into.scanFromUs, 0, block.length);
  const end = lowerBound(time, into.endUs, first, block.length);

  if (first >= end) {
    return;
  }

  const spanned = into.columnOf(time[end - 1]) - into.columnOf(time[first]) + 1;

  if (end - first <= DENSE_SAMPLES_PER_COLUMN * spanned) {
    for (let index = first; index < end; index++) {
      into.addValue(into.columnOf(time[index]), values[index]);
    }

    bounds.rawSamples += end - first;
    return;
  }

  const pyramid = block.pyramids[column];

  for (let start = first; start < end;) {
    const pixel = into.columnOf(time[start]);
    const stop = into.firstIndexInColumn(time, pixel + 1, start, end);
    bounds.clear();
    pyramid.addSamples(values, start, stop, bounds);
    into.addBounds(pixel, bounds);
    start = stop;
  }
}

function decimateEvicted(
  into: DecimationBuilder,
  block: Block,
  column: number,
  bounds: MinMaxAccumulator,
  access: BlockAccess
): void {
  const times = block.leafTimes;
  const leaves = Math.ceil(block.length / LEAF_SIZE);
  const first = Math.max(0, upperBound(times, into.scanFromUs, 0, leaves) - 1);
  const end = lowerBound(times, into.endUs, first, leaves);

  if (first >= end) {
    return;
  }

  const spanned = into.columnOf(times[end - 1]) - into.columnOf(times[first]) + 1;

  if ((end - first) * LEAF_SIZE < RELOAD_SAMPLES_PER_COLUMN * spanned) {
    access.request(block);
  }

  const pyramid = block.pyramids[column];

  for (let start = first; start < end;) {
    const pixel = into.columnOf(times[start]);
    const stop = into.firstIndexInColumn(times, pixel + 1, start, end);
    bounds.clear();
    pyramid.addLeaves(start, stop, bounds);
    into.addBounds(pixel, bounds);
    start = stop;
  }
}

function breakAtGaps(into: DecimationBuilder, gaps: readonly RunGap[]): void {
  for (let gap = firstGapFrom(gaps, into.scanFromUs); gap < gaps.length;) {
    const afterUs = gaps[gap].afterUs;

    if (afterUs >= into.endUs) {
      return;
    }

    const last = lastGapInColumn(into, gaps, into.columnOf(afterUs), gap);
    into.breakBetween(gaps[last].afterUs, gaps[last].untilUs);
    gap = last + 1;
  }
}

/**
 * Fill a decimation with the samples of a variable's segments, in the columns from
 * {@link DecimationBuilder.fromColumn} on.
 *
 * Resident blocks give exact bounds: dense stretches go through the pyramids, reading raw samples
 * only at the edges of each column, and sparse ones, such as the live window, are scanned
 * directly. Evicted blocks answer from their pyramids, with column edges rounded to whole leaves
 * of 16 samples, and are asked back when the view is fine enough for the rounding to show. Gaps
 * cost one search per column that holds any.
 *
 * @param into The decimation, already reset to the window.
 * @param segments The variable's runs, oldest first.
 * @param boundaries Where the link lost the robot.
 * @param access How to reach raw samples.
 * @param stats Where to add what the query read, if anywhere.
 */
export function decimateSegments(
  into: DecimationBuilder,
  segments: readonly Segment[],
  boundaries: readonly Boundary[],
  access: BlockAccess,
  stats?: DecimationStats
): void {
  const bounds = new MinMaxAccumulator();

  for (let index = 0; index < segments.length; index++) {
    const { run, column } = segments[index];

    if (column < 0 || run.keptCount === 0 || run.lastTimeUs < into.scanFromUs) {
      continue;
    }

    const blocks = run.blocks;

    for (let at = firstBlockFrom(blocks, into.scanFromUs); at < blocks.length; at++) {
      const block = blocks[at];

      if (block.length === 0) {
        continue;
      }

      if (block.firstTimeUs >= into.endUs) {
        break;
      }

      access.markUsed(block);

      if (block.resident) {
        decimateResident(into, block, column, bounds);
      } else {
        decimateEvicted(into, block, column, bounds, access);
      }
    }

    breakAtGaps(into, run.gaps);

    if (index < segments.length - 1) {
      into.breakBetween(run.lastTimeUs, nextStart(segments, index + 1));
    }
  }

  for (const boundary of boundaries) {
    into.breakAt(boundary.timeUs);
  }

  if (stats) {
    stats.rawSamples += bounds.rawSamples;
    stats.pyramidEntries += bounds.pyramidEntries;
  }
}
