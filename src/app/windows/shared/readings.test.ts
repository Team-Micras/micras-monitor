import { describe, expect, test } from 'vitest';

import { TypeCode } from '@/protocol';
import type { BitmaskType, EnumType } from '@/robot-kit';

import { formatReading, isStale, STALE_AFTER_US, staleAfterUs } from './readings';

const STATE: EnumType = { kind: 'enum', name: 'State', options: [{ value: 3, label: 'RUN' }] };
const PROFILE: BitmaskType = {
  kind: 'bitmask',
  name: 'Profile',
  flags: [
    { bit: 0, label: 'FAN' },
    { bit: 2, label: 'BOOST' },
  ],
};

describe('formatReading', () => {
  test('reads enums, bitmasks and plain values', () => {
    expect(formatReading(3, STATE)).toBe('RUN');
    expect(formatReading(7, STATE)).toBe('7');
    expect(formatReading(5, PROFILE)).toBe('FAN · BOOST');
    expect(formatReading(0, PROFILE)).toBe('none');
    expect(formatReading((1n << 63n) | 4n, PROFILE)).toBe('BOOST');
    expect(formatReading(3n, STATE)).toBe('RUN');
    expect(formatReading(0.5, null)).toBe('0.500');
    expect(formatReading(undefined, STATE)).toBe('—');
  });

  test("reads the flags of a negative number from its two's complement", () => {
    const high: BitmaskType = { kind: 'bitmask', name: 'High', flags: [{ bit: 7, label: 'TOP' }] };
    expect(formatReading(-127, high, TypeCode.I8)).toBe('TOP');
    expect(formatReading(127, high, TypeCode.I8)).toBe('none');
  });
});

describe('isStale', () => {
  const sample = { value: 1, timeUs: 10_000_000 };

  test('is stale with the link down, or behind the newest sample of the session', () => {
    expect(isStale(sample, 10_000_000, false)).toBe(true);
    expect(isStale(sample, 10_000_000 + STALE_AFTER_US, true)).toBe(false);
    expect(isStale(sample, 10_000_001 + STALE_AFTER_US, true)).toBe(true);
  });

  test('waits three sample periods of a slow stream, and at least the floor', () => {
    expect(staleAfterUs(100)).toBe(STALE_AFTER_US);
    expect(staleAfterUs(1)).toBe(3_000_000);
    expect(staleAfterUs(0)).toBe(STALE_AFTER_US);
    expect(isStale(sample, 12_000_000, true, staleAfterUs(1))).toBe(false);
    expect(isStale(sample, 13_000_001, true, staleAfterUs(1))).toBe(true);
  });

  test('never calls a missing value or a READ answer stale with the link up', () => {
    expect(isStale(undefined, 1e12, false)).toBe(false);
    expect(isStale({ value: 1, timeUs: undefined }, 1e12, true)).toBe(false);
  });
});
