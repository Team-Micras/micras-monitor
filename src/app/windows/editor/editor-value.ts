/**
 * What the variable editor needs without React: which control a variable gets, turning typed
 * text into a value its type holds, the value of an enum option, and a refusal in words.
 *
 * @module
 */

import { isFloat, isWide, VALUE_TYPES, type ValueType } from '@/core/variables';
import type { BitmaskType, EnumType } from '@/robot-kit';

import type { WriteRefusal, WriteValue } from '../../ports';

/** The control a variable is edited with. */
export type EditorControl =
  | { readonly kind: 'bool' }
  | { readonly kind: 'enum'; readonly labels: EnumType; readonly wide: boolean }
  | { readonly kind: 'bitmask'; readonly labels: BitmaskType; readonly wide: boolean }
  | { readonly kind: 'number'; readonly type: ValueType }
  | { readonly kind: 'none' };

/** Text turned into a value, or why it cannot be one. */
export type ParsedValue =
  | { readonly ok: true; readonly value: WriteValue }
  | { readonly ok: false; readonly error: string };

const F32_MAX = 3.4028234663852886e38;

const REFUSALS: Record<WriteRefusal, string> = {
  'no-such-variable': 'the robot has no such variable',
  'read-only': 'the variable is read only',
  'needs-idle': 'the robot takes it only while idle',
  'wrong-size': 'the value does not have the size of the type',
};

/** The control for a variable of a type, with the labels the package gives it. */
export function editorControl(
  type: ValueType,
  labels: EnumType | BitmaskType | null
): EditorControl {
  if (type === 'bytes') {
    return { kind: 'none' };
  }

  if (type === 'bool') {
    return { kind: 'bool' };
  }

  if (labels?.kind === 'enum') {
    return { kind: 'enum', labels, wide: isWide(type) };
  }

  if (labels?.kind === 'bitmask') {
    return { kind: 'bitmask', labels, wide: isWide(type) };
  }

  return { kind: 'number', type };
}

/**
 * Text as a value of a numeric type: a finite float within the type's range for f32 and f64, a
 * whole number within the range for the integers, as a bigint for the 64 bit ones.
 */
export function parseValue(text: string, type: ValueType): ParsedValue {
  const trimmed = text.trim();

  if (trimmed === '') {
    return { ok: false, error: 'Enter a value' };
  }

  if (isFloat(type)) {
    const value = Number(trimmed);

    if (!Number.isFinite(value)) {
      return { ok: false, error: 'Enter a finite number' };
    }

    if (type === 'f32' && Math.abs(value) > F32_MAX) {
      return { ok: false, error: 'Too large for an f32' };
    }

    return { ok: true, value };
  }

  const { range } = VALUE_TYPES[type];

  if (range === null) {
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

  return { ok: true, value: isWide(type) ? value : Number(value) };
}

/** The value an enum option is written as: a bigint for the 64 bit types. */
export function optionValue(value: number, wide: boolean): WriteValue {
  return wide ? BigInt(value) : value;
}

/** Why the robot refused a write, in words. */
export function refusalText(reason: WriteRefusal): string {
  return REFUSALS[reason];
}
