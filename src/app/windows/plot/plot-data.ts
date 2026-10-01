/**
 * What a plot draws, computed from the history without React or uPlot: its axes by unit, the
 * decimated columns uPlot takes, the live window and the gaps worth showing.
 *
 * @module
 */

import { liveWindow, toLineSeries, type LineSeries, type PlotValue } from '@/telemetry';

import type { Decimation, TelemetryStore, TimeRange } from '@/telemetry';

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
export function latestEnd(history: TelemetryStore, names: readonly string[]): number | undefined {
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
 * The live window of a plot: the last `spanUs` up to the newest sample, moved in whole columns
 * so that the lines do not shimmer. Undefined while none of the variables has a sample.
 */
export function followWindow(
  history: TelemetryStore,
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
  history: TelemetryStore,
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
  readonly #history: TelemetryStore;
  readonly #decimations = new Map<string, Decimation>();
  readonly #lines = new Map<string, LineSeries>();
  readonly #x: number[] = [];

  constructor(history: TelemetryStore) {
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
