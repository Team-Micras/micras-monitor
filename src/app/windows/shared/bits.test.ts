import { describe, expect, test } from 'vitest';

import { TypeCode } from '@/protocol';

import { bitSet, integerValue, sameInteger, withBit } from './bits';

describe('bits', () => {
  test('set and clear one bit of a number, leaving the others', () => {
    expect(withBit(0b0101, 1, true, TypeCode.U8)).toBe(0b0111);
    expect(withBit(0b0101, 2, false, TypeCode.U8)).toBe(0b0001);
    expect(withBit(0b0101, 0, true, TypeCode.U8)).toBe(0b0101);
    expect(withBit(2 ** 40, 40, false, TypeCode.U64)).toBe(0);
  });

  test('keep every bit of a 64 bit value', () => {
    const high = (1n << 63n) | 1n;
    expect(bitSet(high, 63)).toBe(true);
    expect(bitSet(high, 62)).toBe(false);
    expect(withBit(high, 62, true, TypeCode.U64)).toBe(high | (1n << 62n));
    expect(withBit(high, 63, false, TypeCode.U64)).toBe(1n);
  });

  test('keep a 64 bit value within the range of its type', () => {
    expect(withBit(1n, 63, true, TypeCode.I64)).toBe(-(1n << 63n) + 1n);
    expect(withBit(-(1n << 63n) + 1n, 63, false, TypeCode.I64)).toBe(1n);
    expect(withBit(1n, 63, true, TypeCode.U64)).toBe((1n << 63n) | 1n);
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
