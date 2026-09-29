import { describe, expect, test } from 'vitest';

import { TypeCode } from '@/protocol';
import type { BitmaskType, EnumType } from '@/robot-kit';

import { editorControl, parseValue, refusalText, sameValue, withBit } from './editor-value';

const STATE: EnumType = { kind: 'enum', name: 'State', options: [{ value: 0, label: 'IDLE' }] };
const PROFILE: BitmaskType = {
  kind: 'bitmask',
  name: 'Profile',
  flags: [{ bit: 0, label: 'FAN' }],
};

describe('editorControl', () => {
  test('picks the control by type and labels', () => {
    expect(editorControl(TypeCode.BOOL, null)).toEqual({ kind: 'bool' });
    expect(editorControl(TypeCode.U8, STATE)).toEqual({ kind: 'enum', labels: STATE });
    expect(editorControl(TypeCode.U8, PROFILE)).toEqual({ kind: 'bitmask', labels: PROFILE });
    expect(editorControl(TypeCode.F32, null)).toEqual({ kind: 'number', type: TypeCode.F32 });
    expect(editorControl(TypeCode.BLOB, STATE)).toEqual({ kind: 'none' });
  });
});

describe('parseValue', () => {
  test.each([
    [TypeCode.U8, '255', 255],
    [TypeCode.I8, '-128', -128],
    [TypeCode.U16, ' 65535 ', 65_535],
    [TypeCode.I32, '+17', 17],
    [TypeCode.U32, '4294967295', 4_294_967_295],
    [TypeCode.F32, '-1.5e3', -1500],
    [TypeCode.F64, '0.1', 0.1],
    [TypeCode.U64, '18446744073709551615', 18_446_744_073_709_551_615n],
    [TypeCode.I64, '-9223372036854775808', -9_223_372_036_854_775_808n],
  ])('takes a value its type holds (%s, %s)', (type, text, value) => {
    expect(parseValue(text, type)).toEqual({ ok: true, value });
  });

  test.each([
    [TypeCode.U8, '256', 'Enter 0 to 255'],
    [TypeCode.I8, '-129', 'Enter -128 to 127'],
    [TypeCode.U32, '-1', 'Enter 0 to 4294967295'],
    [TypeCode.I16, '1.5', 'Enter a whole number'],
    [TypeCode.U64, '18446744073709551616', 'Enter 0 to 18446744073709551615'],
    [TypeCode.F32, '1e39', 'Too large for an f32'],
    [TypeCode.F64, 'NaN', 'Enter a finite number'],
    [TypeCode.F64, 'Infinity', 'Enter a finite number'],
    [TypeCode.F32, '  ', 'Enter a value'],
    [TypeCode.BOOL, '1', 'This type cannot be typed in'],
  ])('refuses a value its type cannot hold (%s, %s)', (type, text, error) => {
    expect(parseValue(text, type)).toEqual({ ok: false, error });
  });
});

describe('withBit', () => {
  test('sets and clears one bit, leaving the others', () => {
    expect(withBit(0b0101, 1, true)).toBe(0b0111);
    expect(withBit(0b0101, 2, false)).toBe(0b0001);
    expect(withBit(0b0101, 0, true)).toBe(0b0101);
    expect(withBit(2 ** 40, 40, false)).toBe(0);
  });
});

describe('sameValue', () => {
  test('compares across number, bigint and boolean', () => {
    expect(sameValue(true, 1)).toBe(true);
    expect(sameValue(5n, 5)).toBe(true);
    expect(sameValue(5, 6)).toBe(false);
    expect(sameValue(undefined, 0)).toBe(false);
  });
});

describe('refusalText', () => {
  test('says why in words', () => {
    expect(refusalText('needs-idle')).toBe('the robot takes it only while idle');
  });
});
