/**
 * The connection's counters as the Link window shows them: rates in words and the streams, the
 * ones the source cut first.
 *
 * @module
 */

import type { StreamRate } from '@/core/source';
import type { Variable } from '@/core/variables';

/** A stream as the window lists it, by the name of its variable. */
export interface NamedStream extends StreamRate {
  readonly variable: string;
}

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

/** Whether the source granted a stream less than the windows asked for. */
export function isCut(stream: StreamRate): boolean {
  return stream.grantedHz < stream.askedHz;
}

/**
 * The streams of variables the robot has, by name, cut ones first, each group by name.
 *
 * @param streams The streams, by variable id.
 * @param variables The robot's variables.
 */
export function orderedStreams(
  streams: readonly StreamRate[],
  variables: readonly Variable[]
): readonly NamedStream[] {
  const names = new Map(variables.map((variable) => [variable.id, variable.name]));

  return streams
    .flatMap((stream) => {
      const variable = names.get(stream.variableId);
      return variable === undefined ? [] : [{ ...stream, variable }];
    })
    .toSorted(
      (left, right) =>
        Number(isCut(right)) - Number(isCut(left)) || left.variable.localeCompare(right.variable)
    );
}

/** A rate in hertz, whole above ten, one decimal below. */
export function formatHz(hertz: number): string {
  return hertz >= 10 || hertz === 0 ? String(Math.round(hertz)) : hertz.toFixed(1);
}
