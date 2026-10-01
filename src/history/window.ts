import type { TimeRange } from './types';

const bits = new DataView(new ArrayBuffer(8));

/**
 * The smallest float above a finite value, so that `[start, nextUp(last))` holds `last`.
 */
export function nextUp(value: number): number {
  if (value === 0) {
    return Number.MIN_VALUE;
  }

  bits.setFloat64(0, value);
  const raw = bits.getBigUint64(0);
  bits.setBigUint64(0, value > 0 ? raw + 1n : raw - 1n);
  return bits.getFloat64(0);
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
 * A window holding a whole history on a grid of columns a power of two wide, so that the grid
 * stays put while the history grows and only the trailing columns change; it moves only when the
 * history outgrows it, to columns twice as wide.
 *
 * @param range The history, as `timeRange` gives it.
 * @param pixels How many columns to split it into; at least 2.
 */
export function historyWindow(range: TimeRange, pixels: number): TimeRange {
  const span = Math.max(range.endUs - range.startUs, Number.MIN_VALUE);
  const width = 2 ** Math.ceil(Math.log2(span / Math.max(1, pixels - 1)));
  const startUs = Math.floor(range.startUs / width) * width;
  return { startUs, endUs: startUs + pixels * width };
}
