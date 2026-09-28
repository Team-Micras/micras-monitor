/**
 * Formatting of values and times for the screen.
 *
 * @module
 */

import type { TelemetryValue } from '../ports';

/**
 * A value as a readout shows it: integers whole, other numbers with three decimals, 64 bit
 * integers with every digit, blobs by size.
 */
export function formatValue(value: TelemetryValue | undefined): string {
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
