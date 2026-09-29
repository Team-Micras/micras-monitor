/**
 * Integers as the robot reports them, a number or a 64 bit bigint, compared and taken apart bit
 * by bit without losing the bits a number cannot hold.
 *
 * @module
 */

import { TYPE_SIZE, TypeCode } from '@/protocol';

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

function stored(value: IntegerValue, type: TypeCode): bigint {
  return BigInt.asUintN(TYPE_SIZE[type] * 8, BigInt(value));
}

/**
 * Whether a bit of an integer of the given type is set, in the two's complement of the type's
 * width, exactly for bigints too.
 */
export function bitSet(value: IntegerValue, bit: number, type: TypeCode): boolean {
  return Number.isInteger(Number(value)) && ((stored(value, type) >> BigInt(bit)) & 1n) === 1n;
}

const SIGNED_TYPES: ReadonlySet<TypeCode> = new Set([
  TypeCode.I8,
  TypeCode.I16,
  TypeCode.I32,
  TypeCode.I64,
]);

/**
 * An integer of the given type with one bit set or cleared, of the same kind as the one given.
 * The bit is changed in the two's complement of the type's width and the result is converted
 * back, so it stays within the range of the type: bit 7 of an `i8` makes it negative.
 */
export function withBit(
  value: IntegerValue,
  bit: number,
  on: boolean,
  type: TypeCode
): IntegerValue {
  if (typeof value === 'number' && !Number.isInteger(value)) {
    return value;
  }

  const width = TYPE_SIZE[type] * 8;
  const mask = 1n << BigInt(bit);
  const bits = stored(value, type);
  const changed = on ? bits | mask : bits & ~mask;
  const result = SIGNED_TYPES.has(type)
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
