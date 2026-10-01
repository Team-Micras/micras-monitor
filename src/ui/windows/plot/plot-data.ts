/**
 * What a plot draws, computed from the history without React or uPlot: its axes by unit, the
 * decimated columns uPlot takes, the live window and the gaps worth showing.
 *
 * @module
 */

import {
  COLUMN_BREAKS,
  COLUMN_HAS_DATA,
  COLUMN_HAS_NAN,
  type Decimation,
  type HistoryStore,
  type TimeRange,
} from '@/history';

/**
 * A y value for uPlot: a number is drawn, `null` breaks the line, `undefined` is skipped and the
 * line carries on across it.
 */
export type PlotValue = number | null | undefined;

/**
 * One line, ready for uPlot's `setData` as `[x, y]`.
 *
 * Each pixel column takes three slots: its minimum, its maximum, and a slot that is `null` where
 * the line breaks, after a gap or a NaN. A column holding only NaN is `null` in all three. Every
 * series decimated over the same window and width gets the same `x`, so several of them can share
 * one plot.
 */
export interface LineSeries {
  /** The times of the slots. */
  readonly x: number[];

  /** The values of the slots. */
  readonly y: PlotValue[];
}

function breakSlot(flags: number): null | undefined {
  return (flags & (COLUMN_BREAKS | COLUMN_HAS_NAN)) !== 0 ? null : undefined;
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

    if ((state & COLUMN_HAS_DATA) !== 0) {
      into.y[slot] = min[column];
      into.y[slot + 1] = max[column];
      into.y[slot + 2] = breakSlot(state);
    } else if ((state & COLUMN_HAS_NAN) !== 0) {
      into.y[slot] = null;
      into.y[slot + 1] = null;
      into.y[slot + 2] = null;
    } else {
      into.y[slot] = undefined;
      into.y[slot + 1] = undefined;
      into.y[slot + 2] = breakSlot(state);
    }
  }

  return into;
}

/** A variable of a plot, as it is drawn. */
export interface PlotVariable {
  readonly name: string;
  readonly unit: string | null;
  readonly color: string;
}

/** A y axis of a plot, shared by the variables of one unit. */
export interface PlotAxis {
  /** The uPlot scale the axis draws. */
  readonly scale: string;
  readonly unit: string | null;
  readonly side: 'left' | 'right';
}

/** The axes of a plot and the scale of each of its variables, in order. */
export interface PlotLayout {
  readonly axes: readonly PlotAxis[];
  readonly scales: readonly string[];
}

/** The columns uPlot's `setData` takes: times in seconds, then one line per variable. */
export type PlotColumns = [x: number[], ...y: PlotValue[][]];

/** A stretch where samples were lost or not kept, clipped to the window. */
export interface GapSpan {
  readonly kind: 'dropped' | 'not-stored';
  readonly startUs: number;
  readonly endUs: number;
}

/** The gaps of the variables of a plot that are worth marking, with how many samples they hold. */
export interface VisibleGaps {
  readonly spans: readonly GapSpan[];
  /** Samples the sequence numbers show as lost in the window, over every variable. */
  readonly dropped: number;
  /** Samples that arrived but were not kept, over every variable. */
  readonly notStored: number;
}

/** The most columns a plot asks for, whatever its width. */
export const MAX_PLOT_COLUMNS = 4096;

const MICROSECONDS = 1e6;

/**
 * One y axis per unit, in the order the units first appear: the first on the left, the others
 * on the right. Variables without a unit share an axis of their own.
 */
export function layoutAxes(variables: readonly PlotVariable[]): PlotLayout {
  const axes: PlotAxis[] = [];
  const scales = variables.map(({ unit }) => {
    const found = axes.find((axis) => axis.unit === unit);

    if (found) {
      return found.scale;
    }

    const axis: PlotAxis = {
      scale: `y${axes.length}`,
      unit,
      side: axes.length === 0 ? 'left' : 'right',
    };
    axes.push(axis);
    return axis.scale;
  });

  return { axes, scales };
}

/** Where the newest sample of any of the variables is, as an exclusive end; undefined for none. */
export function latestEnd(history: HistoryStore, names: readonly string[]): number | undefined {
  let end: number | undefined;

  for (const name of names) {
    const range = history.timeRange(name);

    if (range && (end === undefined || range.endUs > end)) {
      end = range.endUs;
    }
  }

  return end;
}

/**
 * The live window ending at the latest sample, moved in whole columns, so that the columns do not
 * shimmer as the window slides: each sample stays in the same column until it scrolls out.
 *
 * @param latestUs The time of the latest sample; the window holds it.
 * @param spanUs How long the window is.
 * @param pixels How many columns it is split into.
 */
export function liveWindow(latestUs: number, spanUs: number, pixels: number): TimeRange {
  const width = spanUs / pixels;
  const endUs = (Math.floor(latestUs / width) + 1) * width;
  return { startUs: endUs - pixels * width, endUs };
}

/**
 * The live window of a plot: the last `spanUs` up to the newest sample, moved in whole columns
 * so that the lines do not shimmer. Undefined while none of the variables has a sample.
 */
export function followWindow(
  history: HistoryStore,
  names: readonly string[],
  spanUs: number,
  pixels: number
): TimeRange | undefined {
  const end = latestEnd(history, names);
  return end === undefined ? undefined : liveWindow(end, spanUs, pixels);
}

/**
 * The dropped and not-stored gaps of the variables in a window, clipped to it, each counted once
 * however many of the variables share it, as variables of one stream group do. Time a variable
 * spent outside any stream only breaks its line.
 */
export function visibleGaps(
  history: HistoryStore,
  names: readonly string[],
  window: TimeRange
): VisibleGaps {
  const spans: GapSpan[] = [];
  const seen = new Set<string>();
  let dropped = 0;
  let notStored = 0;

  for (const name of names) {
    for (const gap of history.gaps(name, window.startUs, window.endUs)) {
      const key = `${gap.kind} ${gap.startUs} ${gap.endUs}`;

      if (gap.kind === 'not-streamed' || seen.has(key)) {
        continue;
      }

      seen.add(key);
      const startUs = Number.isNaN(gap.startUs) ? window.startUs : gap.startUs;
      const endUs = Number.isNaN(gap.endUs) ? window.endUs : gap.endUs;
      spans.push({
        kind: gap.kind,
        startUs: Math.max(startUs, window.startUs),
        endUs: Math.min(endUs, window.endUs),
      });

      if (gap.kind === 'dropped') {
        dropped += gap.count ?? 0;
      } else {
        notStored += gap.count ?? 0;
      }
    }
  }

  return { spans, dropped, notStored };
}

/**
 * Builds a plot's columns from the history, frame after frame, reusing the decimations and the
 * arrays of the previous frame so that a live plot allocates nothing once it runs.
 */
export class PlotData {
  readonly #history: HistoryStore;
  readonly #decimations = new Map<string, Decimation>();
  readonly #lines = new Map<string, LineSeries>();
  readonly #x: number[] = [];

  constructor(history: HistoryStore) {
    this.#history = history;
  }

  /**
   * The columns of a window split into `pixels` columns: three slots per column, its minimum,
   * its maximum and a `null` where the line breaks, with times in seconds.
   *
   * @param names The variables, in the order of the plot's series.
   * @param window The time window.
   * @param pixels How many columns; clamped to `[1, MAX_PLOT_COLUMNS]`.
   */
  build(names: readonly string[], window: TimeRange, pixels: number): PlotColumns {
    const columns = Math.min(MAX_PLOT_COLUMNS, Math.max(1, Math.round(pixels)));
    const ys = names.map((name) => this.#line(name, window, columns));
    const x = ys[0]?.x ?? [];
    this.#x.length = x.length;

    for (let slot = 0; slot < x.length; slot++) {
      this.#x[slot] = x[slot] / MICROSECONDS;
    }

    return [this.#x, ...ys.map((line) => line.y)];
  }

  #line(name: string, window: TimeRange, pixels: number): LineSeries {
    const decimation = this.#history.decimate(name, window.startUs, window.endUs, pixels, {
      into: this.#decimations.get(name),
    });
    this.#decimations.set(name, decimation);
    const line = toLineSeries(decimation, this.#lines.get(name));
    this.#lines.set(name, line);
    return line;
  }
}

/** Seconds on the session timeline, for the x scale of uPlot. */
export function toSeconds(timeUs: number): number {
  return timeUs / MICROSECONDS;
}

/** Microseconds on the session timeline, from the x scale of uPlot. */
export function toMicroseconds(seconds: number): number {
  return seconds * MICROSECONDS;
}
