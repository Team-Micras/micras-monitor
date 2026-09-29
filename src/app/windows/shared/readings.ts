/**
 * How a window writes a value in words: enum labels, set flags, numbers with their digits
 * lined up, and whether the value is too old to trust.
 *
 * @module
 */

import { TypeCode } from '@/protocol';
import { enumLabel, type BitmaskType, type EnumType } from '@/robot-kit';

import { formatValue } from '../../lib/format';
import type { LatestValue, TelemetryValue } from '../../ports';
import { bitSet } from './bits';

/** A sample older than this, against the newest of the session, is stale at the least. */
export const STALE_AFTER_US = 1_500_000;

/** How many sample periods a value may miss before it is stale. */
export const STALE_PERIODS = 3;

/**
 * How old a sample may get before it is stale, at a rate: three periods, and never less than
 * {@link STALE_AFTER_US}.
 *
 * @param rateHz The rate the variable streams at; zero or less for none.
 */
export function staleAfterUs(rateHz: number): number {
  return rateHz > 0 ? Math.max(STALE_AFTER_US, (STALE_PERIODS * 1e6) / rateHz) : STALE_AFTER_US;
}

/**
 * A value in words: an enum's label, the labels of the set flags of a bitmask, else the value
 * as a readout shows it.
 *
 * @param type The variable's type, which decides the bits of a negative number; a 64 bit one when
 *   omitted.
 */
export function formatReading(
  value: TelemetryValue | undefined,
  labels: EnumType | BitmaskType | null,
  type: TypeCode = TypeCode.U64
): string {
  if ((typeof value !== 'number' && typeof value !== 'bigint') || labels === null) {
    return formatValue(value);
  }

  if (labels.kind === 'enum') {
    return enumLabel(labels, Number(value));
  }

  const set = labels.flags
    .filter((flag) => bitSet(value, flag.bit, type))
    .map((flag) => flag.label);
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
 * @param afterUs How old a sample may get, as {@link staleAfterUs} gives it for its rate.
 */
export function isStale(
  latest: LatestValue | undefined,
  sessionEndUs: number | undefined,
  live: boolean,
  afterUs = STALE_AFTER_US
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
    sessionEndUs - latest.timeUs > afterUs
  );
}
