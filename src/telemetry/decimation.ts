import type { Block } from './block';
import type { EpochGap } from './epoch';
import { LEAF_SIZE, MinMaxAccumulator } from './pyramid';
import type { Boundary } from './types';
import type { Segment } from './variable';

/** The column holds at least one value. */
export const COLUMN_HAS_DATA = 1;

/** The column holds a NaN, so the line breaks there. */
export const COLUMN_HAS_NAN = 2;

/** The line breaks after the column: an epoch ended, samples were dropped, or the link was lost. */
export const COLUMN_BREAKS = 4;

/**
 * Below this many samples per pixel column, a resident block is scanned sample by sample instead
 * of through its pyramid: the pyramid cannot save anything once a column holds less than two
 * leaves.
 */
const DENSE_SAMPLES_PER_COLUMN = 2 * LEAF_SIZE;

/**
 * Below this many samples per pixel column, rounding a column's edges to whole pyramid leaves
 * would show, so an evicted block is brought back into memory.
 */
const RELOAD_SAMPLES_PER_COLUMN = 4 * LEAF_SIZE;

/**
 * The minimum and maximum of a variable in each pixel column of a time window, with where its
 * line breaks.
 *
 * Make one per plotted series and pass it to every query, so that a frame allocates nothing; the
 * arrays only grow when the plot gets wider. Only the first {@link pixels} entries are the
 * result.
 */
export class Decimation {
  /** The start of the window, inclusive. */
  startUs = 0;

  /** The end of the window, exclusive. */
  endUs = 1;

  /** How many columns the window is split into. */
  pixels = 0;

  /**
   * The smallest value in each column, when {@link COLUMN_HAS_DATA} is set. A column that also
   * has {@link COLUMN_HAS_NAN} is drawn as a break, and its bounds may leave out samples that
   * shared a pyramid entry with the NaN.
   */
  min = new Float64Array(0);

  /** The largest value in each column, on the same terms as {@link min}. */
  max = new Float64Array(0);

  /** What each column holds: a combination of the `COLUMN_*` flags. */
  flags = new Uint8Array(0);

  private scale = 0;

  /**
   * Empty every column for a new window.
   *
   * @param startUs The start of the window, inclusive.
   * @param endUs The end of the window, exclusive.
   * @param pixels How many columns to split it into.
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
    this.scale = pixels / (endUs - startUs);
    this.min.fill(Number.POSITIVE_INFINITY, 0, pixels);
    this.max.fill(Number.NEGATIVE_INFINITY, 0, pixels);
    this.flags.fill(0, 0, pixels);
  }

  /**
   * The column a time inside the window falls in.
   */
  columnOf(timeUs: number): number {
    return Math.min(this.pixels - 1, Math.floor((timeUs - this.startUs) * this.scale));
  }

  /** Whether a time is inside the window. */
  contains(timeUs: number): boolean {
    return timeUs >= this.startUs && timeUs < this.endUs;
  }

  /** Break the line after the column a time falls in, if it is inside the window. */
  breakAt(timeUs: number): void {
    if (this.contains(timeUs)) {
      this.flags[this.columnOf(timeUs)] |= COLUMN_BREAKS;
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
    if (!this.contains(afterUs)) {
      return;
    }

    const column = this.columnOf(afterUs);

    if (untilUs < this.endUs && this.columnOf(untilUs) === column) {
      return;
    }

    this.flags[column] |= COLUMN_BREAKS;
  }

  /** Take one sample into account. */
  addValue(column: number, value: number): void {
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
  /** Whether a block's raw samples are in memory, counting the block as used. */
  touch(block: Block): boolean;

  /** Ask for an evicted block to come back. */
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

function firstGapFrom(gaps: readonly EpochGap[], timeUs: number): number {
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

function nextStart(segments: readonly Segment[], from: number): number {
  for (let index = from; index < segments.length; index++) {
    const { epoch, column } = segments[index];

    if (column >= 0 && epoch.storedCount > 0) {
      return epoch.firstTimeUs;
    }
  }

  return Number.NaN;
}

function decimateResident(
  into: Decimation,
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
  const first = lowerBound(time, into.startUs, 0, block.length);
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
  into: Decimation,
  block: Block,
  column: number,
  bounds: MinMaxAccumulator,
  access: BlockAccess
): void {
  const times = block.leafTimes;
  const leaves = Math.ceil(block.length / LEAF_SIZE);
  const first = Math.max(0, lowerBound(times, into.startUs, 0, leaves) - 1);
  const end = lowerBound(times, into.endUs, first, leaves);
  const firstColumn = Math.max(0, into.columnOf(times[first]));
  const spanned = Math.max(0, into.columnOf(times[end - 1])) - firstColumn + 1;

  if ((end - first) * LEAF_SIZE < RELOAD_SAMPLES_PER_COLUMN * spanned) {
    access.request(block);
  }

  const pyramid = block.pyramids[column];

  for (let start = first; start < end;) {
    const pixel = Math.max(0, into.columnOf(times[start]));
    const stop = into.firstIndexInColumn(times, pixel + 1, start, end);
    bounds.clear();
    pyramid.addLeaves(start, stop, bounds);
    into.addBounds(pixel, bounds);
    start = stop;
  }
}

/**
 * Fill a decimation with the samples of a variable's segments.
 *
 * Resident blocks give exact bounds: dense stretches go through the pyramids, reading raw samples
 * only at the edges of each column, and sparse ones, such as the live window, are scanned
 * directly. Evicted blocks answer from their pyramids, with column edges rounded to whole leaves
 * of 16 samples, and are asked back when the view is fine enough for the rounding to show.
 *
 * @param into The decimation, already reset to the window.
 * @param segments The variable's epochs, oldest first.
 * @param boundaries Where the link lost the robot.
 * @param access How to reach raw samples.
 * @param stats Where to add what the query read, if anywhere.
 */
export function decimateSegments(
  into: Decimation,
  segments: readonly Segment[],
  boundaries: readonly Boundary[],
  access: BlockAccess,
  stats?: DecimationStats
): void {
  const bounds = new MinMaxAccumulator();

  for (let index = 0; index < segments.length; index++) {
    const { epoch, column } = segments[index];

    if (column < 0 || epoch.storedCount === 0) {
      continue;
    }

    if (epoch.lastTimeUs < into.startUs || epoch.firstTimeUs >= into.endUs) {
      continue;
    }

    for (const block of epoch.blocks) {
      if (block.length === 0 || block.lastTimeUs < into.startUs) {
        continue;
      }

      if (block.firstTimeUs >= into.endUs) {
        break;
      }

      if (access.touch(block)) {
        decimateResident(into, block, column, bounds);
      } else {
        decimateEvicted(into, block, column, bounds, access);
      }
    }

    for (let gap = firstGapFrom(epoch.gaps, into.startUs); gap < epoch.gaps.length; gap++) {
      const { afterUs, untilUs } = epoch.gaps[gap];

      if (afterUs >= into.endUs) {
        break;
      }

      into.breakBetween(afterUs, untilUs);
    }

    if (index < segments.length - 1) {
      into.breakBetween(epoch.lastTimeUs, nextStart(segments, index + 1));
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
