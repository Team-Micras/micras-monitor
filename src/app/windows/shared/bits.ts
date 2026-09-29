/**
 * Integers as the robot reports them, a number or a 64 bit bigint, compared and taken apart bit
 * by bit without losing the bits a number cannot hold.
 *
 * @module
 */

import { hasBit } from '@/robot-kit';

import type { TelemetryValue, WriteValue } from '../../ports';

/** An integer value: a number, or a bigint for the 64 bit types. */
export type IntegerValue = number | bigint;

/** A value as an integer: booleans as 0 and 1, others undefined. */
export function integerValue(
  value: TelemetryValue | WriteValue | undefined
): IntegerValue | undefined {
  if (typeof value === 'number' || typeof value === 'bigint') {
    return value;
  }

  return typeof value === 'boolean' ? Number(value) : undefined;
}

/** Whether a bit of an integer is set, exactly for bigints too. */
export function bitSet(value: IntegerValue, bit: number): boolean {
  return typeof value === 'bigint' ? ((value >> BigInt(bit)) & 1n) === 1n : hasBit(value, bit);
}

/** An integer with one bit set or cleared, of the same kind as the one given. */
export function withBit(value: IntegerValue, bit: number, on: boolean): IntegerValue {
  if (typeof value === 'bigint') {
    const mask = 1n << BigInt(bit);
    return on ? value | mask : value & ~mask;
  }

  if (bitSet(value, bit) === on) {
    return value;
  }

  return on ? value + 2 ** bit : value - 2 ** bit;
}

/** Whether two integers are equal, across number and bigint. */
export function sameInteger(
  left: IntegerValue | undefined,
  right: IntegerValue | undefined
): boolean {
  if (left === undefined || right === undefined) {
    return left === right;
  }

  if (typeof left === 'bigint' || typeof right === 'bigint') {
    return Number.isInteger(Number(left)) && Number.isInteger(Number(right))
      ? BigInt(left) === BigInt(right)
      : false;
  }

  return left === right;
}
