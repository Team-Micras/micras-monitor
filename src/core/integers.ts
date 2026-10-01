/**
 * Integers as a robot reports them, a number or a bigint for the wide types, compared and taken
 * apart bit by bit without losing the bits a number cannot hold.
 *
 * @module
 */

import { VALUE_TYPES, type Value, type ValueType } from './variables';

/** An integer value: a number, or a bigint for the wide types. */
export type IntegerValue = number | bigint;

/** A value as an integer: booleans as 0 and 1, anything else undefined. */
export function integerValue(value: Value | undefined): IntegerValue | undefined {
  if (typeof value === 'number' || typeof value === 'bigint') {
    return value;
  }

  return typeof value === 'boolean' ? Number(value) : undefined;
}

function widthOf(type: ValueType): number {
  return VALUE_TYPES[type].size * 8;
}

function stored(value: IntegerValue, type: ValueType): bigint {
  return BigInt.asUintN(widthOf(type), BigInt(value));
}

/**
 * Whether a bit of an integer of the given type is set, in the two's complement of the type's
 * width, exactly for bigints too.
 */
export function bitSet(value: IntegerValue, bit: number, type: ValueType): boolean {
  return Number.isInteger(Number(value)) && ((stored(value, type) >> BigInt(bit)) & 1n) === 1n;
}

/**
 * An integer of the given type with one bit set or cleared, of the same kind as the one given.
 * The bit is changed in the two's complement of the type's width and the result is converted
 * back, so it stays within the range of the type: bit 7 of an `i8` makes it negative.
 */
export function withBit(
  value: IntegerValue,
  bit: number,
  on: boolean,
  type: ValueType
): IntegerValue {
  if (typeof value === 'number' && !Number.isInteger(value)) {
    return value;
  }

  const width = widthOf(type);
  const mask = 1n << BigInt(bit);
  const bits = stored(value, type);
  const changed = on ? bits | mask : bits & ~mask;
  const result = VALUE_TYPES[type].signed
    ? BigInt.asIntN(width, changed)
    : BigInt.asUintN(width, changed);
  return typeof value === 'bigint' ? result : Number(result);
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
