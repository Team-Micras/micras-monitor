import { describe, expect, test } from 'vitest';

import { decodeAccess, MAX_GROUPS, TypeCode } from '@/sources/micras-comm/wire';
import { SAMPLE_HEADER_SIZE, wireSize } from '@/sources/micras-comm/link/messages';
import type { SchemaEntry } from '@/sources/micras-comm/link/schema';
import {
  MIN_DEGRADED_RATE_HZ,
  fitGroups,
  type RateRequest,
} from '@/sources/micras-comm/streaming/fit-groups';

const LOOP_US = 125;
const STREAM = decodeAccess(0x01);

function schemaOf(names: readonly string[], type = TypeCode.F32): SchemaEntry[] {
  return names.map((name, id) => ({ id, name, type, access: STREAM }));
}

const CONTROL = [0, 1, 2, 3, 4, 5, 6].map((index) => `control/${index}`);
const SCHEMA: SchemaEntry[] = [
  ...schemaOf(CONTROL),
  { id: 7, name: 'state', type: TypeCode.U8, access: STREAM },
  { id: 8, name: 'battery', type: TypeCode.F32, access: STREAM },
  { id: 9, name: 'maze', type: TypeCode.BLOB, access: STREAM, typeTag: 'maze' },
  { id: 10, name: 'secret', type: TypeCode.U32, access: decodeAccess(0x00) },
];

const at =
  (rateHz: number, pinned = false) =>
  (variable: string) =>
    ({ variable, rateHz, pinned }) satisfies RateRequest;

function plan(requests: readonly RateRequest[], budget = 1e9, schema = SCHEMA) {
  return fitGroups({
    schema,
    loopTimeUs: LOOP_US,
    requests,
    budgetBytesPerSecond: budget,
  });
}

function rateOf(result: ReturnType<typeof plan>, variable: string): number {
  return result.rates.find((rate) => rate.variable === variable)?.grantedHz ?? Number.NaN;
}

describe('fitGroups', () => {
  test('costs a group as its framed sample times its rate', () => {
    const result = plan(CONTROL.map(at(100)));
    const frame = wireSize(SAMPLE_HEADER_SIZE + 7 * 4);

    expect(result.groups).toEqual([{ variableIds: [0, 1, 2, 3, 4, 5, 6], periodTicks: 80 }]);
    expect(result.usedBytesPerSecond).toBeCloseTo(frame * 100);
    expect(result.overBudget).toBe(false);
  });

  test('groups variables by rate, fastest first, and merges repeats at the fastest rate', () => {
    const result = plan([
      at(2, true)('battery'),
      ...CONTROL.slice(0, 2).map(at(50)),
      at(10, true)('state'),
      at(100)('control/0'),
    ]);

    expect(result.groups.map((group) => group.periodTicks)).toEqual([80, 160, 800, 4000]);
    expect(result.groups.map((group) => group.variableIds)).toEqual([[0], [1], [7], [8]]);
    expect(rateOf(result, 'control/0')).toBeCloseTo(100);
  });

  test('merges the rate classes whose merge costs fewest bytes until the groups fit the robot', () => {
    const result = plan([
      at(100)('control/0'),
      at(90)('control/1'),
      at(20)('control/2'),
      at(5)('control/3'),
      at(1)('control/4'),
    ]);

    expect(result.groups).toHaveLength(MAX_GROUPS);
    expect(rateOf(result, 'control/1')).toBeCloseTo(100);
    expect(rateOf(result, 'control/2')).toBeCloseTo(20);
    expect(rateOf(result, 'control/4')).toBeCloseTo(1);
  });

  test('leaves out blobs, variables that cannot stream and unknown names', () => {
    const result = plan([at(10)('maze'), at(10)('secret'), at(10)('ghost'), at(10)('state')]);

    expect(result.rates.map((rate) => rate.variable)).toEqual(['state']);
    expect(result.groups).toEqual([{ variableIds: [7], periodTicks: 800 }]);
  });

  test('fits the budget by slowing every unpinned group by one factor, pinned untouched', () => {
    const requests = [...CONTROL.map(at(100)), at(10, true)('state'), at(2, true)('battery')];
    const full = plan(requests);
    const budget = 1500;
    const result = plan(requests, budget);

    expect(full.usedBytesPerSecond).toBeGreaterThan(budget);
    expect(result.overBudget).toBe(true);
    expect(result.usedBytesPerSecond).toBeLessThanOrEqual(budget);
    expect(result.usedBytesPerSecond).toBeGreaterThan(budget * 0.95);
    expect(rateOf(result, 'state')).toBeCloseTo(10);
    expect(rateOf(result, 'battery')).toBeCloseTo(2);
    expect(rateOf(result, 'control/0')).toBeLessThan(100);
    expect(rateOf(result, 'control/0')).toBe(rateOf(result, 'control/6'));
    expect(result.rates.find((rate) => rate.variable === 'control/0')?.rateHz).toBe(100);
  });

  test('keeps rates in proportion when it slows several unpinned groups', () => {
    const result = plan([at(100)('control/0'), at(50)('control/1')], 600);
    const ratio = rateOf(result, 'control/0') / rateOf(result, 'control/1');

    expect(result.usedBytesPerSecond).toBeLessThanOrEqual(600);
    expect(ratio).toBeGreaterThan(1.8);
    expect(ratio).toBeLessThan(2.2);
  });

  test('slows pinned groups only once the unpinned ones are at their floor', () => {
    const requests = [...CONTROL.map(at(100)), at(50, true)('state')];
    const unpinnedFloor = wireSize(SAMPLE_HEADER_SIZE + 28) * MIN_DEGRADED_RATE_HZ;
    const stateFull = wireSize(SAMPLE_HEADER_SIZE + 1) * 50;
    const budget = unpinnedFloor + stateFull / 2;
    const result = plan(requests, budget);

    expect(rateOf(result, 'control/0')).toBeCloseTo(MIN_DEGRADED_RATE_HZ);
    expect(rateOf(result, 'state')).toBeLessThan(50);
    expect(rateOf(result, 'state')).toBeGreaterThan(20);
    expect(result.usedBytesPerSecond).toBeLessThanOrEqual(budget);
  });

  test('keeps a pinned variable apart from unpinned ones asking for the same rate', () => {
    const floats = Array.from({ length: 12 }, (_, index) => `f/${index}`);
    const schema = [
      ...schemaOf(floats),
      { id: 12, name: 'state', type: TypeCode.U8, access: STREAM },
    ];
    const result = plan([at(10, true)('state'), ...floats.map(at(10))], 300, schema);

    expect(result.groups).toHaveLength(2);
    expect(rateOf(result, 'state')).toBeCloseTo(10);
    expect(rateOf(result, 'f/0')).toBeLessThan(10);
    expect(result.usedBytesPerSecond).toBeLessThanOrEqual(300);
  });

  test('shares a group between pinned and unpinned only when the groups run out', () => {
    const result = plan([
      at(100, true)('state'),
      at(100)('control/0'),
      at(50)('control/1'),
      at(20)('control/2'),
      at(5)('control/3'),
    ]);

    expect(result.groups).toHaveLength(MAX_GROUPS);
    expect(result.groups.find((group) => group.variableIds.includes(7))?.variableIds).toEqual([7]);
  });

  test('does not slow a merged group below the floor its fastest member is owed', () => {
    const names = Array.from({ length: 50 }, (_, index) => `v/${index}`);
    const block = (from: number, rateHz: number) =>
      names.slice(from, from + 16).map((variable) => ({ variable, rateHz }));
    const result = plan(
      [at(0.2)('v/48'), at(2)('v/49'), ...block(0, 20), ...block(16, 50), ...block(32, 100)],
      1,
      schemaOf(names)
    );

    expect(result.groups.find((group) => group.variableIds.includes(49))?.variableIds).toContain(
      48
    );
    expect(rateOf(result, 'v/49')).toBeCloseTo(MIN_DEGRADED_RATE_HZ);
  });

  test('says when even the floor rates do not fit, and keeps them', () => {
    const result = plan([...CONTROL.map(at(100)), at(10, true)('state')], 10);

    expect(result.overBudget).toBe(true);
    expect(result.usedBytesPerSecond).toBeGreaterThan(10);
    expect(rateOf(result, 'control/0')).toBeCloseTo(MIN_DEGRADED_RATE_HZ);
    expect(rateOf(result, 'state')).toBeCloseTo(MIN_DEGRADED_RATE_HZ);
  });

  test('does not slow a stream below what it asked for', () => {
    const result = plan([at(0.5)('battery'), at(100)('control/0')], 20);

    expect(rateOf(result, 'battery')).toBeCloseTo(0.5);
  });

  test('splits a rate class into groups a frame can carry and leaves out what does not fit', () => {
    const names = Array.from({ length: 80 }, (_, index) => `v/${index}`);
    const schema = schemaOf(names);
    const result = plan([at(10, true)('v/79'), ...names.slice(0, 79).map(at(10))], 1e9, schema);

    expect(result.groups).toHaveLength(MAX_GROUPS);
    expect(result.groups.every((group) => group.variableIds.length <= 16)).toBe(true);
    expect(rateOf(result, 'v/79')).toBeCloseTo(10);
    expect(result.rates.filter((rate) => rate.grantedHz === 0)).toHaveLength(16);
    expect(result.overBudget).toBe(true);
  });

  test('plans nothing for nothing', () => {
    const result = plan([]);

    expect(result.groups).toEqual([]);
    expect(result.usedBytesPerSecond).toBe(0);
    expect(result.overBudget).toBe(false);
  });
});
