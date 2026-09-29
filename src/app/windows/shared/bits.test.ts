import { describe, expect, test } from 'vitest';

import { bitSet, integerValue, sameInteger, withBit } from './bits';

describe('bits', () => {
  test('set and clear one bit of a number, leaving the others', () => {
    expect(withBit(0b0101, 1, true)).toBe(0b0111);
    expect(withBit(0b0101, 2, false)).toBe(0b0001);
    expect(withBit(0b0101, 0, true)).toBe(0b0101);
    expect(withBit(2 ** 40, 40, false)).toBe(0);
  });

  test('keep every bit of a 64 bit value', () => {
    const high = (1n << 63n) | 1n;
    expect(bitSet(high, 63)).toBe(true);
    expect(bitSet(high, 62)).toBe(false);
    expect(withBit(high, 62, true)).toBe(high | (1n << 62n));
    expect(withBit(high, 63, false)).toBe(1n);
  });

  test('compare integers across number and bigint', () => {
    expect(sameInteger(5n, 5)).toBe(true);
    expect(sameInteger(5, 6)).toBe(false);
    expect(sameInteger(0.5, 1n)).toBe(false);
    expect(sameInteger(undefined, 0)).toBe(false);
    expect(integerValue(true)).toBe(1);
    expect(integerValue(new Uint8Array(1))).toBeUndefined();
  });
});
