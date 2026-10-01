import { describe, expect, test } from 'vitest';

import { decodeAccess, TypeCode } from '@/sources/micras-comm/wire';
import { toGroupLayouts } from '@/sources/micras-comm/link/group-configurator';
import type { SchemaEntry } from '@/sources/micras-comm/link/schema';

const STREAM = decodeAccess(0x01);

const SCHEMA: SchemaEntry[] = [
  { id: 0, name: 'a', type: TypeCode.F32, access: STREAM },
  { id: 1, name: 'b', type: TypeCode.U16, access: STREAM },
  { id: 2, name: 'flag', type: TypeCode.BOOL, access: STREAM },
  { id: 3, name: 'count', type: TypeCode.U64, access: STREAM },
  { id: 4, name: 'hidden', type: TypeCode.F32, access: decodeAccess(0x02) },
  { id: 5, name: 'maze', type: TypeCode.BLOB, access: STREAM },
];

describe('toGroupLayouts', () => {
  test('adds up the sample size from the schema', () => {
    const [layout] = toGroupLayouts(SCHEMA, [{ variableIds: [0, 1, 2], periodTicks: 80 }]);

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
    expect(() => toGroupLayouts(SCHEMA, requests)).toThrow(message);
  });
});
