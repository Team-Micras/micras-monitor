import { COLUMN_BREAKS, COLUMN_HAS_DATA, COLUMN_HAS_NAN, type Decimation } from './decimation';

/**
 * A y value for uPlot: a number is drawn, `null` breaks the line, `undefined` is skipped and the
 * line carries on across it.
 */
export type PlotValue = number | null | undefined;

/**
 * One line, ready for uPlot's `setData` as `[x, y]`.
 *
 * Each pixel column takes three slots: its minimum, its maximum, and a slot that is `null` where
 * the line breaks. Every series decimated over the same window and width gets the same `x`, so
 * several of them can share one plot.
 */
export interface LineSeries {
  /** The times of the slots. */
  readonly x: number[];

  /** The values of the slots. */
  readonly y: PlotValue[];
}

/**
 * A min/max band, ready for uPlot's `setData` as `[x, min, max]` with a band between the two.
 *
 * Each pixel column takes two slots: its bounds, and a slot that is `null` where the band breaks.
 */
export interface BandSeries {
  /** The times of the slots. */
  readonly x: number[];

  /** The lower edge of the band. */
  readonly min: PlotValue[];

  /** The upper edge of the band. */
  readonly max: PlotValue[];
}

function breakSlot(flags: number): null | undefined {
  return (flags & COLUMN_BREAKS) !== 0 ? null : undefined;
}

/**
 * Lay a decimation out as a line.
 *
 * @param decimation The result of a query.
 * @param into Arrays to reuse, so that a frame allocates nothing.
 * @returns The line, in `into` if it was given.
 */
export function toLineSeries(
  decimation: Decimation,
  into: LineSeries = { x: [], y: [] }
): LineSeries {
  const { pixels, startUs, min, max, flags } = decimation;
  const width = (decimation.endUs - startUs) / pixels;
  into.x.length = 3 * pixels;
  into.y.length = 3 * pixels;

  for (let column = 0; column < pixels; column++) {
    const slot = 3 * column;
    const left = startUs + column * width;
    const state = flags[column];
    into.x[slot] = left + 0.25 * width;
    into.x[slot + 1] = left + 0.5 * width;
    into.x[slot + 2] = left + 0.75 * width;

    if ((state & COLUMN_HAS_NAN) !== 0) {
      into.y[slot] = null;
      into.y[slot + 1] = null;
      into.y[slot + 2] = null;
    } else if ((state & COLUMN_HAS_DATA) !== 0) {
      into.y[slot] = min[column];
      into.y[slot + 1] = max[column];
      into.y[slot + 2] = breakSlot(state);
    } else {
      into.y[slot] = undefined;
      into.y[slot + 1] = undefined;
      into.y[slot + 2] = breakSlot(state);
    }
  }

  return into;
}

/**
 * Lay a decimation out as a min/max band.
 *
 * @param decimation The result of a query.
 * @param into Arrays to reuse, so that a frame allocates nothing.
 * @returns The band, in `into` if it was given.
 */
export function toBandSeries(
  decimation: Decimation,
  into: BandSeries = { x: [], min: [], max: [] }
): BandSeries {
  const { pixels, startUs, min, max, flags } = decimation;
  const width = (decimation.endUs - startUs) / pixels;
  into.x.length = 2 * pixels;
  into.min.length = 2 * pixels;
  into.max.length = 2 * pixels;

  for (let column = 0; column < pixels; column++) {
    const slot = 2 * column;
    const left = startUs + column * width;
    const state = flags[column];
    const gap = breakSlot(state);
    into.x[slot] = left + width / 3;
    into.x[slot + 1] = left + (2 * width) / 3;
    into.min[slot + 1] = gap;
    into.max[slot + 1] = gap;

    if ((state & COLUMN_HAS_NAN) !== 0) {
      into.min[slot] = null;
      into.max[slot] = null;
      into.min[slot + 1] = null;
      into.max[slot + 1] = null;
    } else if ((state & COLUMN_HAS_DATA) !== 0) {
      into.min[slot] = min[column];
      into.max[slot] = max[column];
    } else {
      into.min[slot] = undefined;
      into.max[slot] = undefined;
    }
  }

  return into;
}
