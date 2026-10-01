import { describe, expect, test } from 'vitest';

import { TypeCode } from '@/sources/micras-comm/wire/constants';
import {
  defaultValue,
  type Fundamental,
  readValue,
  TYPE_SIZE,
  typeName,
  validateValue,
  writeValue,
} from '@/sources/micras-comm/wire/value-codec';

interface CodecCase {
  type: TypeCode;
  name: string;
  value: Fundamental;
  bytes: number[];
}

const PRIMITIVE_CASES: CodecCase[] = [
  { type: TypeCode.BOOL, name: 'bool', value: true, bytes: [1] },
  { type: TypeCode.U8, name: 'u8', value: 200, bytes: [200] },
  { type: TypeCode.I8, name: 'i8', value: -2, bytes: [0xfe] },
  { type: TypeCode.U16, name: 'u16', value: 0x1234, bytes: [0x34, 0x12] },
  { type: TypeCode.I16, name: 'i16', value: -2, bytes: [0xfe, 0xff] },
  { type: TypeCode.U32, name: 'u32', value: 0xdeadbeef, bytes: [0xef, 0xbe, 0xad, 0xde] },
  { type: TypeCode.I32, name: 'i32', value: -2, bytes: [0xfe, 0xff, 0xff, 0xff] },
  {
    type: TypeCode.U64,
    name: 'u64',
    value: 0x0102030405060708n,
    bytes: [8, 7, 6, 5, 4, 3, 2, 1],
  },
  {
    type: TypeCode.I64,
    name: 'i64',
    value: -2n,
    bytes: [0xfe, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff],
  },
  { type: TypeCode.F32, name: 'f32', value: 1, bytes: [0, 0, 0x80, 0x3f] },
  { type: TypeCode.F64, name: 'f64', value: -2, bytes: [0, 0, 0, 0, 0, 0, 0, 0xc0] },
];

describe('type codec', () => {
  test.each(PRIMITIVE_CASES)('writes a $name little endian', ({ type, value, bytes }) => {
    expect([...writeValue(value, type)]).toEqual(bytes);
    expect(TYPE_SIZE[type]).toBe(bytes.length);
  });

  test.each(PRIMITIVE_CASES)('reads a $name back at an offset', ({ type, value, bytes }) => {
    const buffer = new Uint8Array([0xaa, ...bytes, 0xbb]);

    expect(readValue(buffer, 1, type)).toBe(value);
  });

  test.each(PRIMITIVE_CASES)('reads nothing from a buffer too short for a $name', ({ type }) => {
    expect(readValue(new Uint8Array(TYPE_SIZE[type] - 1), 0, type)).toBeNull();
  });

  test.each(PRIMITIVE_CASES)('names a $name', ({ type, name }) => {
    expect(typeName(type)).toBe(name);
  });

  test('treats a blob as having no value of its own', () => {
    expect(TYPE_SIZE[TypeCode.BLOB]).toBe(0);
    expect(typeName(TypeCode.BLOB)).toBe('blob');
    expect(writeValue(0, TypeCode.BLOB)).toHaveLength(0);
    expect(readValue(new Uint8Array(4), 0, TypeCode.BLOB)).toBeNull();
  });

  test('names an unknown code', () => {
    const unknownCode: number = 99;

    expect(typeName(unknownCode)).toBe('unknown');
  });

  test('starts every type at its zero value', () => {
    expect(defaultValue(TypeCode.BOOL)).toBe(false);
    expect(defaultValue(TypeCode.U64)).toBe(0n);
    expect(defaultValue(TypeCode.I64)).toBe(0n);
    expect(defaultValue(TypeCode.F32)).toBe(0);
  });
});

describe('validateValue', () => {
  test.each([
    ['U8', TypeCode.U8, 255],
    ['I8', TypeCode.I8, -128],
    ['U16', TypeCode.U16, 65535],
    ['I32', TypeCode.I32, -2147483648],
    ['U32', TypeCode.U32, 4294967295],
    ['F32', TypeCode.F32, -1e30],
    ['U64', TypeCode.U64, 2n ** 60n],
  ])('accepts a value in range for %s', (_name, type, value) => {
    expect(() => validateValue(value, type)).not.toThrow();
  });

  test.each([
    ['U8', TypeCode.U8, 256],
    ['I8', TypeCode.I8, -129],
    ['U16', TypeCode.U16, -1],
    ['I16', TypeCode.I16, 32768],
    ['U32', TypeCode.U32, 4294967296],
    ['I32', TypeCode.I32, 2147483648],
  ])('refuses a value out of range for %s', (_name, type, value) => {
    expect(() => validateValue(value, type)).toThrow(/out of range/);
  });

  test('refuses a number for a bool and a bool for a number', () => {
    expect(() => validateValue(1, TypeCode.BOOL)).toThrow(/boolean/);
    expect(() => validateValue(true, TypeCode.U8)).toThrow(/number/);
  });

  test('refuses a number that is not finite', () => {
    expect(() => validateValue(Number.NaN, TypeCode.F32)).toThrow(/Invalid number/);
    expect(() => validateValue(Number.POSITIVE_INFINITY, TypeCode.F64)).toThrow(/Invalid number/);
  });
});
