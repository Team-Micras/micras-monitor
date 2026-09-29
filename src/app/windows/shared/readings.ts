/**
 * How a window writes a value in words: enum labels, set flags, numbers with their digits
 * lined up, and whether the value is too old to trust.
 *
 * @module
 */

import { activeFlags, enumLabel, type BitmaskType, type EnumType } from '@/robot-kit';

import { formatValue } from '../../lib/format';
import type { LatestValue, TelemetryValue } from '../../ports';

/** A sample older than this, against the newest of the session, is stale. */
export const STALE_AFTER_US = 1_500_000;

/**
 * A value in words: an enum's label, the labels of the set flags of a bitmask, else the value
 * as a readout shows it.
 */
export function formatReading(
  value: TelemetryValue | undefined,
  labels: EnumType | BitmaskType | null
): string {
  if (typeof value !== 'number' || labels === null) {
    return formatValue(value);
  }

  if (labels.kind === 'enum') {
    return enumLabel(labels, value);
  }

  const set = activeFlags(labels, value).map((flag) => flag.label);
  return set.length === 0 ? 'none' : set.join(' · ');
}

/**
 * Whether a value is too old to trust: the link is down, or the value is a sample well
 * behind the newest of the session. A READ answer, without a timestamp, is stale only with the
 * link down.
 *
 * @param latest The variable's latest value.
 * @param sessionEndUs The end of the session's history, or undefined before any sample.
 * @param live Whether the link is up past its schema.
 */
export function isStale(
  latest: LatestValue | undefined,
  sessionEndUs: number | undefined,
  live: boolean
): boolean {
  if (latest === undefined) {
    return false;
  }

  if (!live) {
    return true;
  }

  return (
    latest.timeUs !== undefined &&
    sessionEndUs !== undefined &&
    sessionEndUs - latest.timeUs > STALE_AFTER_US
  );
}
