import { describe, expect, test } from 'vitest';

import type { BitmaskType, EnumType } from '@/robot-kit';

import { formatReading, isStale, STALE_AFTER_US } from './readings';

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
    expect(formatReading(0.5, null)).toBe('0.500');
    expect(formatReading(undefined, STATE)).toBe('—');
  });
});

describe('isStale', () => {
  const sample = { value: 1, timeUs: 10_000_000 };

  test('is stale with the link down, or behind the newest sample of the session', () => {
    expect(isStale(sample, 10_000_000, false)).toBe(true);
    expect(isStale(sample, 10_000_000 + STALE_AFTER_US, true)).toBe(false);
    expect(isStale(sample, 10_000_001 + STALE_AFTER_US, true)).toBe(true);
  });

  test('never calls a missing value or a READ answer stale with the link up', () => {
    expect(isStale(undefined, 1e12, false)).toBe(false);
    expect(isStale({ value: 1, timeUs: undefined }, 1e12, true)).toBe(false);
  });
});
