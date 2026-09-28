import { describe, expect, test } from 'vitest';

import { decodeAccess, TypeCode, writeValue } from '../protocol';
import { EpochRegistry, planGroups, sameLayout, type Epoch, type EpochEndReason } from './groups';
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

function recordingRegistry() {
  const events: string[] = [];
  let lastId = 100;
  const registry = new EpochRegistry(
    {
      opened: (epoch: Epoch) => events.push(`opened ${epoch.id}`),
      ended: (epoch: Epoch, reason: EpochEndReason) => events.push(`ended ${epoch.id} ${reason}`),
    },
    () => ++lastId
  );

  return { registry, events };
}

describe('epochs', () => {
  const [layout] = planGroups(SCHEMA, [{ variableIds: [0, 2, 3], periodTicks: 8 }]);
  const define = (registry: EpochRegistry, timeline = 1) =>
    registry.define(layout, 8, layout.sampleSize, timeline);

  test('every definition opens an epoch with an id from the source', () => {
    const { registry } = recordingRegistry();
    const first = define(registry);
    const second = define(registry);

    expect([first.epoch.id, second.epoch.id]).toEqual([101, 102]);
    expect(registry.current(0)).toBe(second);
    expect(sameLayout(layout, second.epoch)).toBe(true);
  });

  test('an epoch is announced once enabled, and only an announced one is reported ended', () => {
    const { registry, events } = recordingRegistry();

    define(registry);
    define(registry);
    registry.activate(0);
    registry.activate(0);
    define(registry);
    registry.activate(0);
    registry.end(0, 'disabled');

    expect(events).toEqual([
      'opened 102',
      'ended 102 redefined',
      'opened 103',
      'ended 103 disabled',
    ]);
    expect(registry.active()).toEqual([]);
  });

  test('a new timeline carries each stream on under a new epoch, sequence and all', () => {
    const { registry, events } = recordingRegistry();
    const before = define(registry, 1);

    registry.activate(0);
    before.advance(0);
    registry.moveToTimeline(2);

    const after = registry.current(0);
    expect(after?.epoch).toMatchObject({ id: 102, timeline: 2, variableIds: [0, 2, 3] });
    expect(after?.advance(1)).toBe(0);
    expect(events).toEqual(['opened 101', 'ended 101 clock-reset', 'opened 102']);
  });

  test('an epoch not announced yet moves to the new timeline silently, to be announced there', () => {
    const { registry, events } = recordingRegistry();

    define(registry, 1);
    registry.moveToTimeline(2);

    expect(events).toEqual([]);
    expect(registry.current(0)?.epoch).toMatchObject({ id: 102, timeline: 2 });

    registry.activate(0);

    expect(events).toEqual(['opened 102']);
  });

  test('a sequence gap inside an epoch counts the samples dropped', () => {
    const open = define(recordingRegistry().registry);

    expect(open.advance(0)).toBe(0);
    expect(open.advance(1)).toBe(0);
    expect(open.advance(5)).toBe(3);
    expect(open.advance(6)).toBe(0);
  });

  test('samples dropped before the first one arrived are counted too', () => {
    const open = define(recordingRegistry().registry);

    expect(open.advance(2)).toBe(2);
  });

  test('the u16 sequence wraps without a gap', () => {
    const open = define(recordingRegistry().registry);

    open.advance(0);
    open.advance(0xfffe);

    expect(open.advance(0xffff)).toBe(0);
    expect(open.advance(0)).toBe(0);
  });

  test('a new epoch starts its sequence from zero', () => {
    const { registry } = recordingRegistry();
    define(registry).advance(40);

    expect(define(registry).advance(0)).toBe(0);
  });

  test('decodes values by type and refuses the wrong size', () => {
    const open = define(recordingRegistry().registry);
    const bytes = new Uint8Array([
      ...writeValue(1.5, TypeCode.F32),
      ...writeValue(true, TypeCode.BOOL),
      ...writeValue(BigInt(2) ** BigInt(60), TypeCode.U64),
    ]);

    expect(open.decode(bytes)).toEqual([1.5, 1, BigInt(2) ** BigInt(60)]);
    expect(open.decode(bytes.subarray(1))).toBeNull();
  });
});
