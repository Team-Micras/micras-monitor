import { describe, expect, test } from 'vitest';

import type { ValueType } from '@/core/variables';
import { accessOf, valueTypeOf, variableOf } from '@/sources/micras-comm/value-types';
import { decodeAccess, encodeAccess, TypeCode } from '@/sources/micras-comm/wire';

describe('valueTypeOf', () => {
  test.each<[number, ValueType]>([
    [0, 'bool'],
    [1, 'u8'],
    [2, 'i8'],
    [3, 'u16'],
    [4, 'i16'],
    [5, 'u32'],
    [6, 'i32'],
    [7, 'u64'],
    [8, 'i64'],
    [9, 'f32'],
    [10, 'f64'],
    [11, 'bytes'],
  ])('maps the firmware type code %i to %s', (code, type) => {
    expect(valueTypeOf(code as TypeCode)).toBe(type);
  });
});

describe('accessOf', () => {
  test.each([
    [0x01, { stream: true, write: false, writeNeedsIdle: false, persists: false }],
    [0x02, { stream: false, write: true, writeNeedsIdle: false, persists: false }],
    [0x04, { stream: false, write: false, writeNeedsIdle: true, persists: false }],
    [0x08, { stream: false, write: false, writeNeedsIdle: false, persists: true }],
  ])('maps the access bit %i to its own flag', (bits, access) => {
    expect(accessOf(decodeAccess(bits))).toEqual(access);
  });

  test('packs every access byte back into itself', () => {
    for (let bits = 0; bits < 16; bits++) {
      expect(encodeAccess(decodeAccess(bits))).toBe(bits);
    }
  });
});

describe('variableOf', () => {
  test('carries the type tag of an entry that has one, and no tag otherwise', () => {
    const access = decodeAccess(0x08);
    const tagged = variableOf({
      id: 1,
      name: 'maze',
      type: TypeCode.BLOB,
      access,
      typeTag: 'maze-grid',
    });
    const plain = variableOf({ id: 2, name: 'state', type: TypeCode.U8, access });

    expect(tagged).toEqual({
      id: 1,
      name: 'maze',
      type: 'bytes',
      access: { stream: false, write: false, writeNeedsIdle: false, persists: true },
      tag: 'maze-grid',
    });
    expect(plain).toEqual({
      id: 2,
      name: 'state',
      type: 'u8',
      access: { stream: false, write: false, writeNeedsIdle: false, persists: true },
    });
    expect('tag' in plain).toBe(false);
  });
});
