/**
 * Moving a paused plot through the history: panning and zooming its time window, kept within
 * reach of the samples, without React or uPlot.
 *
 * @module
 */

import type { HistoryPort, TimeRange } from '../../ports';

/** The shortest window a plot zooms in to: a millisecond. */
export const MIN_SPAN_US = 1000;

/** The share of the window one arrow key press moves it by. */
export const PAN_STEP = 0.1;

/** How much one zoom step by the keyboard narrows or widens the window. */
export const ZOOM_STEP = 1.5;

/** The share of the window that may hang past either end of the history. */
const OVERHANG = 0.5;

/** How far the history of a plot's variables reaches. */
export interface HistoryBounds {
  readonly startUs: number;
  readonly endUs: number;
}

/** From the first to the last sample of any of the variables; undefined while none has one. */
export function historyBounds(
  history: HistoryPort,
  names: readonly string[]
): HistoryBounds | undefined {
  let startUs = Number.POSITIVE_INFINITY;
  let endUs = Number.NEGATIVE_INFINITY;

  for (const name of names) {
    const range = history.timeRange(name);

    if (range) {
      startUs = Math.min(startUs, range.startUs);
      endUs = Math.max(endUs, range.endUs);
    }
  }

  return startUs < endUs ? { startUs, endUs } : undefined;
}

function maxSpan(bounds: HistoryBounds): number {
  return Math.max(2 * MIN_SPAN_US, (1 + 2 * OVERHANG) * (bounds.endUs - bounds.startUs));
}

/**
 * A window as long as it may be and placed where it may be: at least {@link MIN_SPAN_US}, at
 * most twice the history, and hanging past either end by half its length at most. A window
 * longer than the history is centred on it.
 */
export function clampWindow(window: TimeRange, bounds: HistoryBounds): TimeRange {
  const span = Math.min(maxSpan(bounds), Math.max(MIN_SPAN_US, window.endUs - window.startUs));
  const earliest = bounds.startUs - OVERHANG * span;
  const latest = bounds.endUs + OVERHANG * span - span;
  const startUs =
    span > bounds.endUs - bounds.startUs
      ? (bounds.startUs + bounds.endUs - span) / 2
      : Math.min(Math.max(window.startUs, earliest), latest);
  return { startUs, endUs: startUs + span };
}

/**
 * The window zoomed around a time, which stays under the pointer.
 *
 * @param factor Above 1 widens the window, below 1 narrows it.
 */
export function zoomWindow(
  window: TimeRange,
  anchorUs: number,
  factor: number,
  bounds: HistoryBounds
): TimeRange {
  const span = window.endUs - window.startUs;
  const next = Math.min(maxSpan(bounds), Math.max(MIN_SPAN_US, span * factor));
  const ratio = span > 0 ? (anchorUs - window.startUs) / span : 0.5;
  const startUs = anchorUs - ratio * next;
  return clampWindow({ startUs, endUs: startUs + next }, bounds);
}

/** The window moved along the time axis; a positive shift goes later. */
export function panWindow(window: TimeRange, shiftUs: number, bounds: HistoryBounds): TimeRange {
  return clampWindow({ startUs: window.startUs + shiftUs, endUs: window.endUs + shiftUs }, bounds);
}

/** The window that holds the whole history. */
export function wholeHistory(bounds: HistoryBounds): TimeRange {
  const span = Math.max(MIN_SPAN_US, bounds.endUs - bounds.startUs);
  return { startUs: bounds.startUs, endUs: bounds.startUs + span };
}
