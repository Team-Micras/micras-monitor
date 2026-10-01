import type { Value, ValueType } from '@/core/variables';

import type { NumericColumn } from './types';

/**
 * How a numeric variable is stored: `f32` for the types a 32 bit float holds exactly, `f64` for
 * the rest.
 */
export type ColumnKind = 'f32' | 'f64';

const COLUMN_KIND: Readonly<Record<ValueType, ColumnKind | undefined>> = {
  bool: 'f32',
  u8: 'f32',
  i8: 'f32',
  u16: 'f32',
  i16: 'f32',
  f32: 'f32',
  u32: 'f64',
  i32: 'f64',
  f64: 'f64',
  u64: 'f64',
  i64: 'f64',
  bytes: undefined,
};

const LARGEST_EXACT = BigInt(Number.MAX_SAFE_INTEGER);

/**
 * The column a type is stored in, or undefined for blobs, which are not stored numerically.
 *
 * Counters such as `localizer/accepted` pass 2²⁴, so 32 bit integers need 64 bit floats.
 */
export function columnKindOf(type: ValueType): ColumnKind | undefined {
  return COLUMN_KIND[type];
}

/**
 * How many bytes one value of a column takes.
 */
export function bytesPerValue(kind: ColumnKind): number {
  return kind === 'f32' ? 4 : 8;
}

/**
 * A zeroed column of the given kind.
 */
export function allocateColumn(kind: ColumnKind, length: number): NumericColumn {
  return kind === 'f32' ? new Float32Array(length) : new Float64Array(length);
}

/**
 * The kind of an existing column.
 */
export function kindOfColumn(column: NumericColumn): ColumnKind {
  return column instanceof Float32Array ? 'f32' : 'f64';
}

/**
 * A value as a float; anything that is not a number, a boolean or an integer becomes NaN.
 */
export function toNumber(value: Value): number {
  if (typeof value === 'number') {
    return value;
  }

  if (typeof value === 'bigint' || typeof value === 'boolean') {
    return Number(value);
  }

  return Number.NaN;
}

/**
 * Whether storing a value as a 64 bit float loses integer precision, that is, whether it lies
 * beyond ±(2⁵³ − 1).
 */
export function losesPrecision(value: Value): boolean {
  if (typeof value === 'bigint') {
    return value > LARGEST_EXACT || value < -LARGEST_EXACT;
  }

  return typeof value === 'number' && Math.abs(value) > Number.MAX_SAFE_INTEGER;
}

const floatBits = new DataView(new ArrayBuffer(8));

/**
 * The smallest float above a finite value, so that `[start, nextUp(last))` holds `last`.
 */
export function nextUp(value: number): number {
  if (value === 0) {
    return Number.MIN_VALUE;
  }

  floatBits.setFloat64(0, value);
  const raw = floatBits.getBigUint64(0);
  floatBits.setBigUint64(0, value > 0 ? raw + 1n : raw - 1n);
  return floatBits.getFloat64(0);
}
