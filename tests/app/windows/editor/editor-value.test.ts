import { describe, expect, test } from 'vitest';

import type { ValueType } from '@/core/variables';
import type { BitmaskType, EnumType } from '@/robot-kit';

import {
  editorControl,
  optionValue,
  parseValue,
  refusalText,
} from '@/app/windows/editor/editor-value';

const STATE: EnumType = { kind: 'enum', name: 'State', options: [{ value: 0, label: 'IDLE' }] };
const PROFILE: BitmaskType = {
  kind: 'bitmask',
  name: 'Profile',
  flags: [{ bit: 0, label: 'FAN' }],
};

describe('editorControl', () => {
  test('picks the control by type and labels', () => {
    expect(editorControl('bool', null)).toEqual({ kind: 'bool' });
    expect(editorControl('u8', STATE)).toEqual({ kind: 'enum', labels: STATE, wide: false });
    expect(editorControl('u8', PROFILE)).toEqual({
      kind: 'bitmask',
      labels: PROFILE,
      wide: false,
    });
    expect(editorControl('u64', PROFILE)).toMatchObject({ kind: 'bitmask', wide: true });
    expect(editorControl('f32', null)).toEqual({ kind: 'number', type: 'f32' });
    expect(editorControl('bytes', STATE)).toEqual({ kind: 'none' });
  });
});

describe('parseValue', () => {
  test.each<[ValueType, string, number | bigint]>([
    ['u8', '255', 255],
    ['i8', '-128', -128],
    ['u16', ' 65535 ', 65_535],
    ['i32', '+17', 17],
    ['u32', '4294967295', 4_294_967_295],
    ['f32', '-1.5e3', -1500],
    ['f64', '0.1', 0.1],
    ['u64', '18446744073709551615', 18_446_744_073_709_551_615n],
    ['i64', '-9223372036854775808', -9_223_372_036_854_775_808n],
  ])('takes a value its type holds (%s, %s)', (type, text, value) => {
    expect(parseValue(text, type)).toEqual({ ok: true, value });
  });

  test.each<[ValueType, string, string]>([
    ['u8', '256', 'Enter 0 to 255'],
    ['i8', '-129', 'Enter -128 to 127'],
    ['u32', '-1', 'Enter 0 to 4294967295'],
    ['i16', '1.5', 'Enter a whole number'],
    ['u64', '18446744073709551616', 'Enter 0 to 18446744073709551615'],
    ['f32', '1e39', 'Too large for an f32'],
    ['f64', 'NaN', 'Enter a finite number'],
    ['f64', 'Infinity', 'Enter a finite number'],
    ['f32', '  ', 'Enter a value'],
    ['bool', '1', 'This type cannot be typed in'],
  ])('refuses a value its type cannot hold (%s, %s)', (type, text, error) => {
    expect(parseValue(text, type)).toEqual({ ok: false, error });
  });
});

describe('optionValue', () => {
  test('writes the options of a 64 bit enum as bigints', () => {
    expect(optionValue(2, true)).toBe(2n);
    expect(optionValue(2, false)).toBe(2);
  });
});

describe('refusalText', () => {
  test('says why in words', () => {
    expect(refusalText('needs-idle')).toBe('the robot takes it only while idle');
  });
});
