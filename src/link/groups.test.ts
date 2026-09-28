import { describe, expect, test } from 'vitest';

import { decodeAccess, TypeCode, writeValue } from '../protocol';
import { EpochRegistry, planGroups, sameLayout } from './groups';
import type { SchemaEntry } from './schema';

const STREAM = decodeAccess(0x01);

const SCHEMA: SchemaEntry[] = [
  { id: 0, name: 'a', type: TypeCode.F32, access: STREAM },
  { id: 1, name: 'b', type: TypeCode.U16, access: STREAM },
  { id: 2, name: 'flag', type: TypeCode.BOOL, access: STREAM },
  { id: 3, name: 'count', type: TypeCode.U64, access: STREAM },
  { id: 4, name: 'hidden', type: TypeCode.F32, access: decodeAccess(0x02) },
  { id: 5, name: 'maze', type: TypeCode.BLOB, access: STREAM },
];

describe('planGroups', () => {
  test('adds up the sample size from the schema', () => {
    const [layout] = planGroups(SCHEMA, [{ variableIds: [0, 1, 2], periodTicks: 80 }]);

    expect(layout).toMatchObject({
      group: 0,
      sampleSize: 7,
      types: [TypeCode.F32, TypeCode.U16, TypeCode.BOOL],
    });
  });

  test.each([
    [[{ variableIds: [4], periodTicks: 1 }], 'hidden cannot be streamed'],
    [[{ variableIds: [5], periodTicks: 1 }], 'maze cannot be streamed'],
    [[{ variableIds: [9], periodTicks: 1 }], 'No variable 9'],
    [[{ variableIds: [], periodTicks: 1 }], '1 to 16 variables'],
    [[{ variableIds: [0], periodTicks: 0 }], 'period'],
    [Array.from({ length: 5 }, () => ({ variableIds: [0], periodTicks: 1 })), '4 groups'],
  ])('refuses %j', (requests, message) => {
    expect(() => planGroups(SCHEMA, requests)).toThrow(message);
  });
});

describe('epochs', () => {
  const [layout] = planGroups(SCHEMA, [{ variableIds: [0, 2, 3], periodTicks: 8 }]);

  test('every definition opens an epoch with a new id', () => {
    const registry = new EpochRegistry();
    const first = registry.begin(layout, 8, layout.sampleSize);
    const second = registry.begin(layout, 8, layout.sampleSize);

    expect(second.epoch.id).toBeGreaterThan(first.epoch.id);
    expect(registry.current(0)).toBe(second);
    expect(sameLayout(layout, second.epoch)).toBe(true);
  });

  test('a sequence gap inside an epoch counts the samples dropped', () => {
    const open = new EpochRegistry().begin(layout, 8, layout.sampleSize);

    expect(open.advance(0)).toBe(0);
    expect(open.advance(1)).toBe(0);
    expect(open.advance(5)).toBe(3);
    expect(open.advance(6)).toBe(0);
  });

  test('samples dropped before the first one arrived are counted too', () => {
    const open = new EpochRegistry().begin(layout, 8, layout.sampleSize);

    expect(open.advance(2)).toBe(2);
  });

  test('the u16 sequence wraps without a gap', () => {
    const open = new EpochRegistry().begin(layout, 8, layout.sampleSize);

    open.advance(0);
    open.advance(0xfffe);

    expect(open.advance(0xffff)).toBe(0);
    expect(open.advance(0)).toBe(0);
  });

  test('a new epoch starts its sequence from zero', () => {
    const registry = new EpochRegistry();
    registry.begin(layout, 8, layout.sampleSize).advance(40);

    expect(registry.begin(layout, 8, layout.sampleSize).advance(0)).toBe(0);
  });

  test('decodes values by type and refuses the wrong size', () => {
    const open = new EpochRegistry().begin(layout, 8, layout.sampleSize);
    const bytes = new Uint8Array([
      ...writeValue(1.5, TypeCode.F32),
      ...writeValue(true, TypeCode.BOOL),
      ...writeValue(BigInt(2) ** BigInt(60), TypeCode.U64),
    ]);

    expect(open.decode(bytes)).toEqual([1.5, 1, BigInt(2) ** BigInt(60)]);
    expect(open.decode(bytes.subarray(1))).toBeNull();
  });
});
