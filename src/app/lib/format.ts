/**
 * Formatting of values and times for the screen.
 *
 * @module
 */

import type { Value } from '@/core/variables';

/**
 * A value as a readout shows it: integers whole, other numbers with three decimals, 64 bit
 * integers with every digit, blobs by size.
 */
export function formatValue(value: Value | undefined): string {
  if (value === undefined) {
    return '—';
  }

  if (value instanceof Uint8Array) {
    return `${value.length} B`;
  }

  if (typeof value !== 'number') {
    return String(value);
  }

  return Number.isInteger(value) ? String(value) : value.toFixed(3);
}

/** A duration as `mm:ss.d`, the way the top bar's clock shows it. */
export function formatClock(milliseconds: number): string {
  const tenths = Math.max(0, Math.floor(milliseconds / 100));
  const minutes = Math.floor(tenths / 600);
  const seconds = Math.floor(tenths / 10) % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${tenths % 10}`;
}

/** A schema hash as eight hexadecimal digits. */
export function formatHash(hash: number): string {
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/** A size in bytes, in the largest unit that keeps it at least 1, with one decimal past KB. */
export function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = Math.max(0, bytes);
  let unit = 0;

  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }

  return unit === 0 ? `${value} B` : `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`;
}

/** A duration as `h:mm:ss`, or `mm:ss` under an hour. */
export function formatDuration(milliseconds: number): string {
  const total = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = String(Math.floor(total / 60) % 60).padStart(2, '0');
  const seconds = String(total % 60).padStart(2, '0');
  return hours > 0 ? `${hours}:${minutes}:${seconds}` : `${minutes}:${seconds}`;
}
