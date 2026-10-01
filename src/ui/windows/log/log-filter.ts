/**
 * Which log entries the Log window shows, and how their times read.
 *
 * @module
 */

import type { LogEntry, LogSeverity } from '@/core/log';

import { formatClock } from '../../lib/format';

/** The severities from the least to the most serious. */
export const SEVERITIES: readonly LogSeverity[] = ['debug', 'info', 'warning', 'error'];

/** The most entries the window draws, the newest. */
export const SHOWN_ENTRIES = 300;

/** The entries at least as serious as `minimum`, the newest {@link SHOWN_ENTRIES} of them. */
export function filterLog(entries: readonly LogEntry[], minimum: LogSeverity): readonly LogEntry[] {
  const floor = SEVERITIES.indexOf(minimum);
  const kept =
    floor <= 0 ? entries : entries.filter((entry) => SEVERITIES.indexOf(entry.severity) >= floor);
  return kept.length > SHOWN_ENTRIES ? kept.slice(-SHOWN_ENTRIES) : kept;
}

/** The name an entry is tagged with: the part of the monitor that noted it, none for the robot. */
export function sourceLabel(entry: LogEntry): string | null {
  return entry.source === 'robot' ? null : entry.source;
}

/**
 * When an entry happened, as the top bar's clock reads: the robot's time on the session timeline
 * for its own lines, the time since the link came up for the link's, or the wall clock without a
 * link.
 *
 * @param entry The entry.
 * @param linkedSince When the link came up, in `Date.now()` milliseconds, or null.
 */
export function entryTime(entry: LogEntry, linkedSince: number | null): string {
  if (entry.timeUs !== undefined) {
    return formatClock(entry.timeUs / 1000);
  }

  if (linkedSince !== null && entry.hostTime >= linkedSince) {
    return formatClock(entry.hostTime - linkedSince);
  }

  const date = new Date(entry.hostTime);
  return [date.getHours(), date.getMinutes(), date.getSeconds()]
    .map((part) => String(part).padStart(2, '0'))
    .join(':');
}
