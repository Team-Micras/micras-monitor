import { describe, expect, test } from 'vitest';

import { bitSet, integerValue, sameInteger, withBit } from '@/core/integers';

describe('integers', () => {
  test('set and clear one bit of a number, leaving the others', () => {
    expect(withBit(0b0101, 1, true, 'u8')).toBe(0b0111);
    expect(withBit(0b0101, 2, false, 'u8')).toBe(0b0001);
    expect(withBit(0b0101, 0, true, 'u8')).toBe(0b0101);
    expect(withBit(2 ** 40, 40, false, 'u64')).toBe(0);
  });

  test('keep every bit of a 64 bit value', () => {
    const high = (1n << 63n) | 1n;
    expect(bitSet(high, 63, 'u64')).toBe(true);
    expect(bitSet(high, 62, 'u64')).toBe(false);
    expect(withBit(high, 62, true, 'u64')).toBe(high | (1n << 62n));
    expect(withBit(high, 63, false, 'u64')).toBe(1n);
  });

  test('keep a 64 bit value within the range of its type', () => {
    expect(withBit(1n, 63, true, 'i64')).toBe(-(1n << 63n) + 1n);
    expect(withBit(-(1n << 63n) + 1n, 63, false, 'i64')).toBe(1n);
    expect(withBit(1n, 63, true, 'u64')).toBe((1n << 63n) | 1n);
  });

  test("change bits of a signed number in the two's complement of its width", () => {
    expect(withBit(1, 7, true, 'i8')).toBe(-127);
    expect(withBit(-127, 7, false, 'i8')).toBe(1);
    expect(withBit(-1, 0, false, 'i8')).toBe(-2);
    expect(withBit(-2, 0, true, 'i8')).toBe(-1);
    expect(withBit(1, 15, true, 'i16')).toBe(-32767);
    expect(withBit(-32767, 15, false, 'i16')).toBe(1);
    expect(withBit(-1, 9, false, 'i16')).toBe(-513);
    expect(withBit(0, 31, true, 'i32')).toBe(-(2 ** 31));
  });

  test('read the bits of a negative number as the robot stores them', () => {
    expect(bitSet(-127, 7, 'i8')).toBe(true);
    expect(bitSet(-127, 1, 'i8')).toBe(false);
    expect(bitSet(-127, 0, 'i8')).toBe(true);
    expect(bitSet(-1, 15, 'i16')).toBe(true);
    expect(bitSet(-32768, 14, 'i16')).toBe(false);
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
