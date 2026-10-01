/**
 * How the sessions UI puts a session into words.
 *
 * @module
 */

import type {
  SessionInfo,
  SessionRecovery,
  StorageEstimate,
} from '@/recording/library/recording-library';

import { formatBytes, formatDuration } from '../lib/format';

/** What recovering a recording found, in a few words. */
export function describeRecovery({
  session,
  recovery,
}: {
  readonly session: SessionInfo;
  readonly recovery: SessionRecovery;
}): string {
  const kept = `${formatDuration(session.durationUs / 1000)} kept`;
  const cut =
    recovery.truncatedBytes > 0 ? `, ${formatBytes(recovery.truncatedBytes)} cut at the end` : '';
  const damaged =
    recovery.damagedRecords > 0
      ? `, ${recovery.damagedRecords} damaged ${recovery.damagedRecords === 1 ? 'record' : 'records'} skipped`
      : '';
  return kept + cut + damaged;
}

/** When a session started, as the list shows it. */
export function describeStart(atMs: number): string {
  return new Intl.DateTimeFormat('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(atMs);
}

/** A session's length, size and samples, as the list shows them. */
export function describeSize(session: SessionInfo): string {
  const samples = new Intl.NumberFormat('en-GB', { notation: 'compact' }).format(session.samples);
  return `${formatDuration(session.durationUs / 1000)} · ${formatBytes(session.bytes)} · ${samples} samples`;
}

/** What the browser grants, as the foot of the list says it. */
export function describeStorage(storage: StorageEstimate | null, kind: 'opfs' | 'memory'): string {
  if (kind === 'memory') {
    return 'This browser has no file system for sessions: they last until the tab closes.';
  }

  if (storage === null) {
    return 'Sessions are kept in this browser.';
  }

  const kept = storage.persisted
    ? 'kept by the browser'
    : 'the browser may clear them when the disk fills';
  return `${formatBytes(storage.usage)} of ${formatBytes(storage.quota)} used · ${kept}`;
}
