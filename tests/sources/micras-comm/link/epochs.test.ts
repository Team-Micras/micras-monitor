import { describe, expect, test } from 'vitest';

import { decodeAccess, TypeCode, writeValue } from '@/sources/micras-comm/wire';
import {
  EpochRegistry,
  planGroups,
  sameLayout,
  type Epoch,
  type EpochEndReason,
  type OpenEpoch,
} from '@/sources/micras-comm/link/epochs';
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
    acceptAt(before, 0);
    registry.moveToTimeline(2);

    const after = registry.current(0);
    expect(after?.epoch).toMatchObject({ id: 102, timeline: 2, variableIds: [0, 2, 3] });
    expect(after && acceptAt(after, 1)).toBe(0);
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

    expect(acceptAt(open, 0)).toBe(0);
    expect(acceptAt(open, 1)).toBe(0);
    expect(acceptAt(open, 5)).toBe(3);
    expect(acceptAt(open, 6)).toBe(0);
  });

  test('samples dropped before the first one arrived are counted too', () => {
    const open = define(recordingRegistry().registry);

    expect(acceptAt(open, 2)).toBe(2);
  });

  test('the u16 sequence wraps without a gap', () => {
    const open = define(recordingRegistry().registry);

    acceptAt(open, 0);
    acceptAt(open, 0x7ffe);
    acceptAt(open, 0xfffe);

    expect(acceptAt(open, 0xffff)).toBe(0);
    expect(acceptAt(open, 0, 0x10000)).toBe(0);
  });

  test('a sequence behind the expected one is no gap and moves nothing', () => {
    const open = define(recordingRegistry().registry);

    acceptAt(open, 0);
    acceptAt(open, 40);

    expect(acceptAt(open, 0, 41)).toBeNull();
    expect(acceptAt(open, 40, 42)).toBeNull();
    expect(open.nextSeq).toBe(41);
    expect(acceptAt(open, 41, 43)).toBe(0);
  });

  test('the time settles a sequence half the range ahead or more: a gap that long, or behind', () => {
    const open = define(recordingRegistry().registry);

    acceptAt(open, 0);

    expect(acceptAt(open, 0x8001, 1)).toBeNull();
    expect(acceptAt(open, 0x8001)).toBe(0x8000);
  });

  test('counts by the time the samples taken since the last one accepted', () => {
    const open = define(recordingRegistry().registry);

    expect(open.takenSince(5 * SPACING_US, SPACING_US)).toBe(0);

    acceptAt(open, 0);

    expect(open.takenSince(5 * SPACING_US, SPACING_US)).toBe(5);
    expect(open.takenSince(5 * SPACING_US, 0)).toBe(0);
  });

  test('a new epoch starts its sequence from zero', () => {
    const { registry } = recordingRegistry();
    acceptAt(define(registry), 40);

    expect(acceptAt(define(registry), 0)).toBe(0);
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

const SPACING_US = 10_000;

/** Accept a sample the robot took at its turn: the sample of that index in the epoch. */
function acceptAt(open: OpenEpoch, seq: number, index = seq): number | null {
  return open.accept(seq, (index * SPACING_US) >>> 0, SPACING_US);
}
