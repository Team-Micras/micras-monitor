/**
 * What the variable editor needs without React: which control a variable gets, turning typed
 * text into a value its type holds, the value of an enum option, and a refusal in words.
 *
 * @module
 */

import { TypeCode } from '@/protocol';
import type { BitmaskType, EnumType } from '@/robot-kit';

import type { WriteRefusal, WriteValue } from '../../ports';

/** The control a variable is edited with. */
export type EditorControl =
  | { readonly kind: 'bool' }
  | { readonly kind: 'enum'; readonly labels: EnumType; readonly wide: boolean }
  | { readonly kind: 'bitmask'; readonly labels: BitmaskType; readonly wide: boolean }
  | { readonly kind: 'number'; readonly type: TypeCode }
  | { readonly kind: 'none' };

/** Text turned into a value, or why it cannot be one. */
export type ParsedValue =
  | { readonly ok: true; readonly value: WriteValue }
  | { readonly ok: false; readonly error: string };

const F32_MAX = 3.4028234663852886e38;

const INTEGER_RANGE: Partial<Record<TypeCode, readonly [bigint, bigint]>> = {
  [TypeCode.U8]: [0n, 255n],
  [TypeCode.I8]: [-128n, 127n],
  [TypeCode.U16]: [0n, 65_535n],
  [TypeCode.I16]: [-32_768n, 32_767n],
  [TypeCode.U32]: [0n, 4_294_967_295n],
  [TypeCode.I32]: [-2_147_483_648n, 2_147_483_647n],
  [TypeCode.U64]: [0n, 2n ** 64n - 1n],
  [TypeCode.I64]: [-(2n ** 63n), 2n ** 63n - 1n],
};

const WIDE = new Set([TypeCode.U64, TypeCode.I64]);

const REFUSALS: Record<WriteRefusal, string> = {
  'no-such-variable': 'the robot has no such variable',
  'read-only': 'the variable is read only',
  'needs-idle': 'the robot takes it only while idle',
  'wrong-size': 'the value does not have the size of the type',
};

/** The control for a variable of a type, with the labels the package gives it. */
export function editorControl(
  type: TypeCode,
  labels: EnumType | BitmaskType | null
): EditorControl {
  if (type === TypeCode.BLOB) {
    return { kind: 'none' };
  }

  if (type === TypeCode.BOOL) {
    return { kind: 'bool' };
  }

  if (labels?.kind === 'enum') {
    return { kind: 'enum', labels, wide: WIDE.has(type) };
  }

  if (labels?.kind === 'bitmask') {
    return { kind: 'bitmask', labels, wide: WIDE.has(type) };
  }

  return { kind: 'number', type };
}

/**
 * Text as a value of a numeric type: a finite float within the type's range for f32 and f64, a
 * whole number within the range for the integers, as a bigint for the 64 bit ones.
 */
export function parseValue(text: string, type: TypeCode): ParsedValue {
  const trimmed = text.trim();

  if (trimmed === '') {
    return { ok: false, error: 'Enter a value' };
  }

  if (type === TypeCode.F32 || type === TypeCode.F64) {
    const value = Number(trimmed);

    if (!Number.isFinite(value)) {
      return { ok: false, error: 'Enter a finite number' };
    }

    if (type === TypeCode.F32 && Math.abs(value) > F32_MAX) {
      return { ok: false, error: 'Too large for an f32' };
    }

    return { ok: true, value };
  }

  const range = INTEGER_RANGE[type];

  if (range === undefined) {
    return { ok: false, error: 'This type cannot be typed in' };
  }

  if (!/^[+-]?\d+$/.test(trimmed)) {
    return { ok: false, error: 'Enter a whole number' };
  }

  const value = BigInt(trimmed);
  const [min, max] = range;

  if (value < min || value > max) {
    return { ok: false, error: `Enter ${min} to ${max}` };
  }

  return { ok: true, value: WIDE.has(type) ? value : Number(value) };
}

/** The value an enum option is written as: a bigint for the 64 bit types. */
export function optionValue(value: number, wide: boolean): WriteValue {
  return wide ? BigInt(value) : value;
}

/** Why the robot refused a write, in words. */
export function refusalText(reason: WriteRefusal): string {
  return REFUSALS[reason];
}
