/**
 * The link's counters as the Link window shows them: rates in words and the planned streams,
 * the ones the planner cut first.
 *
 * @module
 */

import type { PlannedStream, StreamBudget } from '../../ports';

/** A rate in bytes per second, as `850 B/s` or `3.2 KB/s`. */
export function formatRate(bytesPerSecond: number): string {
  if (!Number.isFinite(bytesPerSecond)) {
    return '—';
  }

  return bytesPerSecond < 1000
    ? `${Math.round(bytesPerSecond)} B/s`
    : `${(bytesPerSecond / 1000).toFixed(1)} KB/s`;
}

/** A share in `[0, 1]`, of a total that may be zero. */
export function share(part: number, total: number): number {
  return total > 0 ? Math.min(1, Math.max(0, part / total)) : 0;
}

/** Whether the planner granted a stream less than the windows asked for. */
export function isCut(stream: PlannedStream): boolean {
  return stream.grantedHz < stream.rateHz;
}

/** The planned streams, cut ones first, each group by name. */
export function orderedStreams(budget: StreamBudget): readonly PlannedStream[] {
  return budget.planned.toSorted(
    (left, right) =>
      Number(isCut(right)) - Number(isCut(left)) || left.variable.localeCompare(right.variable)
  );
}

/** A rate in hertz, whole above ten, one decimal below. */
export function formatHz(hertz: number): string {
  return hertz >= 10 || hertz === 0 ? String(Math.round(hertz)) : hertz.toFixed(1);
}
