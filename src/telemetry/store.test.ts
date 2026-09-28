import { describe, expect, test } from 'vitest';

import { TypeCode } from '@/protocol';

import { COLUMN_BREAKS, COLUMN_HAS_DATA } from './decimation';
import { ManualScheduler } from './scheduler';
import { toLineSeries } from './series';
import { TelemetryStore, type TelemetryStoreOptions } from './store';
import type { TelemetryEvent } from './types';

const MS = 1000;
const SECOND = 1_000_000;

function makeStore(options: Partial<TelemetryStoreOptions> = {}): TelemetryStore {
  return new TelemetryStore({ scheduler: new ManualScheduler(), blockSize: 256, ...options });
}

function streamSingle(
  store: TelemetryStore,
  epochId: number,
  from: number,
  count: number,
  timeOf: (index: number) => number,
  valueOf: (index: number) => number = (index) => index
): void {
  for (let index = from; index < from + count; index++) {
    store.append(epochId, index, timeOf(index), [valueOf(index)]);
  }
}

function threeEpochs(): TelemetryStore {
  const store = makeStore();
  store.openEpoch({ epochId: 1, groupId: 0, variables: [{ id: 7, type: TypeCode.F32 }] });
  streamSingle(store, 1, 0, 1000, (index) => index * MS);
  store.openEpoch({ epochId: 2, groupId: 0, variables: [{ id: 7, type: TypeCode.F32 }] });
  streamSingle(store, 2, 0, 500, (index) => 2 * SECOND + index * MS);
  streamSingle(store, 2, 510, 490, (index) => 2 * SECOND + index * MS);
  store.markBoundary('reconnect', 3.5 * SECOND);
  store.openEpoch({ epochId: 3, groupId: 0, variables: [{ id: 7, type: TypeCode.F32 }] });
  streamSingle(store, 3, 0, 500, (index) => 4 * SECOND + index * MS);
  return store;
}

function stored(store: TelemetryStore, id: number) {
  const runs = [...store.samples(id, 0, SECOND)];
  expect(runs).toHaveLength(1);
  return runs[0].values;
}

describe('epochs and gaps', () => {
  test('tells time outside any epoch from samples dropped inside one', () => {
    const store = threeEpochs();

    expect(store.gaps(7, 0, 5 * SECOND)).toEqual([
      { kind: 'not-streamed', startUs: 999 * MS, endUs: 2 * SECOND },
      { kind: 'dropped', startUs: 2 * SECOND + 499 * MS, endUs: 2 * SECOND + 510 * MS, count: 10 },
      { kind: 'not-streamed', startUs: 2 * SECOND + 999 * MS, endUs: 4 * SECOND },
    ]);
    expect(store.boundaries()).toEqual([{ kind: 'reconnect', timeUs: 3.5 * SECOND }]);
    expect(store.variable(7)).toMatchObject({ storedSamples: 2490, droppedSamples: 10, epochs: 3 });
  });

  test('restarts the sequence with each epoch and wraps it at 16 bits', () => {
    const store = makeStore();
    store.openEpoch({ epochId: 1, groupId: 0, variables: [{ id: 1, type: TypeCode.U8 }] });

    for (let index = 0; index < 70_000; index++) {
      store.append(1, index & 0xffff, index * MS, [index & 0xff]);
    }

    store.openEpoch({ epochId: 2, groupId: 0, variables: [{ id: 1, type: TypeCode.U8 }] });
    store.append(2, 0, 80 * SECOND, [1]);

    expect(store.variable(1)).toMatchObject({ storedSamples: 70_001, droppedSamples: 0 });
  });

  test('counts samples lost before the first one and those the session reports', () => {
    const store = makeStore();
    store.openEpoch({ epochId: 1, groupId: 0, variables: [{ id: 1, type: TypeCode.F32 }] });
    store.append(1, 3, 0, [1]);
    store.append(1, 4, MS, [1]);
    store.markDropped(1, 2);
    store.append(1, 7, 4 * MS, [1]);

    expect(store.variable(1)?.droppedSamples).toBe(5);
    expect(store.gaps(1, 0, SECOND)).toEqual([
      { kind: 'dropped', startUs: 0, endUs: 0, count: 3 },
      { kind: 'dropped', startUs: MS, endUs: 4 * MS, count: 2 },
    ]);
  });

  test('breaks the line between epochs, at drops and at boundaries, and nowhere else', () => {
    const store = threeEpochs();
    const pixels = 500;
    const decimation = store.decimate(7, 0, 5 * SECOND, pixels);
    const breaks = Array.from({ length: pixels }, (_, column) => column).filter(
      (column) => (decimation.flags[column] & COLUMN_BREAKS) !== 0
    );

    expect(breaks).toEqual([99, 249, 299, 350]);

    const line = toLineSeries(decimation);

    expect(line.y.slice(3 * 99, 3 * 101)).toEqual([
      decimation.min[99],
      decimation.max[99],
      null,
      undefined,
      undefined,
      undefined,
    ]);
    expect(line.x).toHaveLength(3 * pixels);
  });

  test('ignores a duplicate sample and refuses time going backwards', () => {
    const store = makeStore();
    store.openEpoch({ epochId: 1, groupId: 0, variables: [{ id: 1, type: TypeCode.F32 }] });
    store.append(1, 0, 0, [1]);
    store.append(1, 1, MS, [2]);
    store.append(1, 1, MS, [2]);
    store.append(1, 2, 2 * MS, [3]);

    expect(store.variable(1)).toMatchObject({ storedSamples: 3, droppedSamples: 0 });
    expect(() => store.append(1, 3, MS, [4])).toThrow(RangeError);
  });

  test('does not break the line at a drop narrower than a pixel', () => {
    const store = makeStore();
    store.openEpoch({ epochId: 1, groupId: 0, variables: [{ id: 1, type: TypeCode.F32 }] });

    for (let index = 0; index < 3000; index++) {
      if (index % 150 !== 75) {
        store.append(1, index, index * MS, [Math.sin(index)]);
      }
    }

    const coarse = store.decimate(1, 0, 3 * SECOND, 30);
    const fine = store.decimate(1, 0, 3 * SECOND, 3000);

    expect(coarse.flags.some((flags) => (flags & COLUMN_BREAKS) !== 0)).toBe(false);
    expect(
      Array.from(fine.flags.subarray(0, 3000)).filter((flags) => (flags & COLUMN_BREAKS) !== 0)
    ).toHaveLength(20);
  });

  test('refuses a variable already streamed by another open group', () => {
    const store = makeStore();
    store.openEpoch({ epochId: 1, groupId: 0, variables: [{ id: 1, type: TypeCode.F32 }] });

    expect(() =>
      store.openEpoch({ epochId: 2, groupId: 1, variables: [{ id: 1, type: TypeCode.F32 }] })
    ).toThrow('already streamed');

    store.markBoundary('reconnect', 0);

    expect(() =>
      store.openEpoch({ epochId: 3, groupId: 1, variables: [{ id: 1, type: TypeCode.F32 }] })
    ).not.toThrow();
  });

  test('closes the open epoch of a group when the group is defined again', () => {
    const store = makeStore();
    store.openEpoch({ epochId: 1, groupId: 2, variables: [{ id: 1, type: TypeCode.F32 }] });
    store.openEpoch({ epochId: 2, groupId: 3, variables: [{ id: 2, type: TypeCode.F32 }] });
    store.openEpoch({ epochId: 3, groupId: 2, variables: [{ id: 1, type: TypeCode.F32 }] });

    expect(() => store.append(1, 0, 0, [1])).toThrow('closed');
    expect(() => store.append(2, 0, 0, [1])).not.toThrow();
    expect(() => store.append(9, 0, 0, [1])).toThrow('No epoch 9');
    expect(() => store.append(3, 0, 0, [1, 2])).toThrow(RangeError);
    expect(() =>
      store.openEpoch({ epochId: 3, groupId: 1, variables: [{ id: 1, type: TypeCode.F32 }] })
    ).toThrow('already');
  });
});

describe('numeric types', () => {
  const variables = [
    { id: 0, type: TypeCode.BOOL },
    { id: 1, type: TypeCode.U16 },
    { id: 2, type: TypeCode.F32 },
    { id: 3, type: TypeCode.U32 },
    { id: 4, type: TypeCode.I32 },
    { id: 5, type: TypeCode.F64 },
    { id: 6, type: TypeCode.U64 },
    { id: 7, type: TypeCode.I64 },
    { id: 8, type: TypeCode.BLOB },
  ];

  test('keeps narrow types in 32 bit floats and the rest in 64 bit floats', () => {
    const store = makeStore();
    store.openEpoch({ epochId: 1, groupId: 0, variables });
    store.append(1, 0, 0, [
      true,
      65_535,
      0.1,
      4_294_967_295,
      -2_147_483_648,
      0.1,
      2n ** 53n - 1n,
      -(2n ** 40n),
      new Uint8Array([1, 2]),
    ]);
    store.append(1, 1, MS, [
      false,
      1,
      1.5,
      16_777_217,
      16_777_217,
      1 / 3,
      1n,
      1n,
      new Uint8Array(),
    ]);

    expect(stored(store, 0)).toEqual(new Float32Array([1, 0]));
    expect(stored(store, 1)).toEqual(new Float32Array([65_535, 1]));
    expect(stored(store, 2)).toEqual(new Float32Array([Math.fround(0.1), 1.5]));
    expect(stored(store, 3)).toEqual(new Float64Array([4_294_967_295, 16_777_217]));
    expect(stored(store, 4)).toEqual(new Float64Array([-2_147_483_648, 16_777_217]));
    expect(stored(store, 5)).toEqual(new Float64Array([0.1, 1 / 3]));
    expect(stored(store, 6)).toEqual(new Float64Array([2 ** 53 - 1, 1]));
    expect(stored(store, 7)).toEqual(new Float64Array([-(2 ** 40), 1]));
    expect([...store.samples(8, 0, SECOND)]).toEqual([]);
    expect(variables.map(({ id }) => store.variable(id)?.storage)).toEqual([
      'f32',
      'f32',
      'f32',
      'f64',
      'f64',
      'f64',
      'f64',
      'f64',
      'none',
    ]);
    expect(store.variable(6)?.precisionLost).toBe(false);
  });

  test('flags 64 bit integers beyond 2^53 once, and keeps their latest value exact', () => {
    const store = makeStore();
    const events: TelemetryEvent[] = [];
    store.onEvent((event) => events.push(event));
    store.openEpoch({ epochId: 1, groupId: 0, variables: variables.slice(6, 8) });
    store.append(1, 0, 0, [2n ** 53n + 1n, -(2n ** 60n) - 3n]);
    store.append(1, 1, MS, [2n ** 64n - 1n, 0n]);

    expect(store.variable(6)?.precisionLost).toBe(true);
    expect(store.variable(7)?.precisionLost).toBe(true);
    expect(events).toEqual([
      { type: 'precision-loss', variableId: 6 },
      { type: 'precision-loss', variableId: 7 },
    ]);
    expect(store.latest(6)?.value).toBe(2n ** 64n - 1n);
    expect(stored(store, 6)[0]).toBe(2 ** 53);
  });

  test('keeps blobs and read values as latest values, with a short history for blobs', () => {
    const store = makeStore({ historyLength: 3 });
    store.openEpoch({ epochId: 1, groupId: 0, variables: variables.slice(7) });

    for (let index = 0; index < 5; index++) {
      store.append(1, index, index * MS, [BigInt(index), new Uint8Array([index])]);
    }

    store.setLatestValue(20, new Uint8Array([9]));
    store.setLatestValue(7, 42n);

    expect(store.history(8).map(({ value, timeUs }) => [value, timeUs])).toEqual([
      [new Uint8Array([2]), 2 * MS],
      [new Uint8Array([3]), 3 * MS],
      [new Uint8Array([4]), 4 * MS],
    ]);
    expect(store.latest(8)).toBe(store.latest(8));
    expect(store.latest(20)).toEqual({ value: new Uint8Array([9]), timeUs: undefined });
    expect(store.history(20)).toHaveLength(1);
    expect(store.latest(7)).toEqual({ value: 42n, timeUs: undefined });
    expect(store.history(7)).toEqual([]);
    expect(store.variable(7)?.storedSamples).toBe(5);
  });
});

describe('blocks', () => {
  test('are never reallocated or copied as the history grows', () => {
    const blockSize = 1024;
    const store = makeStore({ blockSize });
    store.openEpoch({
      epochId: 1,
      groupId: 0,
      variables: [
        { id: 1, type: TypeCode.F32 },
        { id: 2, type: TypeCode.U32 },
      ],
    });
    const buffers = () =>
      [1, 2].flatMap((id) =>
        [...store.samples(id, 0, Number.POSITIVE_INFINITY)].flatMap((run) => [
          run.time.buffer,
          run.values.buffer,
        ])
      );

    for (let index = 0; index < 3 * blockSize + 10; index++) {
      store.append(1, index, index, [index, index]);
    }

    const before = buffers();

    for (let index = 3 * blockSize + 10; index < 40 * blockSize; index++) {
      store.append(1, index & 0xffff, index, [index, index]);
    }

    const after = buffers();

    expect(before).toHaveLength(2 * 2 * 4);
    after
      .filter((_, index) => index % 80 < 8)
      .forEach((buffer, index) => expect(buffer).toBe(before[index]));
    expect(before.every((buffer) => buffer.byteLength >= 4 * blockSize)).toBe(true);
    expect(store.variable(1)?.storedSamples).toBe(40 * blockSize);
  });

  test('grow from a small first block to the full size', () => {
    const store = makeStore({ blockSize: 4096 });
    store.openEpoch({ epochId: 1, groupId: 0, variables: [{ id: 1, type: TypeCode.F32 }] });
    streamSingle(store, 1, 0, 12_000, (index) => index);

    expect([...store.samples(1, 0, 12_000)].map((run) => run.time.buffer.byteLength / 8)).toEqual([
      1024, 2048, 4096, 4096, 4096,
    ]);
  });

  test('hand out runs as views, split at block edges, for the asked range only', () => {
    const store = makeStore({ blockSize: 256 });
    store.openEpoch({ epochId: 1, groupId: 0, variables: [{ id: 1, type: TypeCode.F64 }] });
    streamSingle(store, 1, 0, 1000, (index) => index * MS);
    const runs = [...store.samples(1, 100 * MS, 700 * MS)];

    expect(runs.map((run) => run.time.length)).toEqual([156, 256, 188]);
    expect(runs[0].time[0]).toBe(100 * MS);
    expect(runs[2].values.at(-1)).toBe(699);
    expect(runs.every((run) => run.epochId === 1)).toBe(true);
  });
});

describe('decimated views', () => {
  test('mark a column without samples as neither data nor gap', () => {
    const store = makeStore();
    store.openEpoch({ epochId: 1, groupId: 0, variables: [{ id: 1, type: TypeCode.F32 }] });
    streamSingle(store, 1, 0, 10, (index) => index * 100 * MS);
    const decimation = store.decimate(1, 0, SECOND, 100);
    const data = Array.from(decimation.flags.subarray(0, 100), (flags) => flags & COLUMN_HAS_DATA);

    expect(data.filter(Boolean)).toHaveLength(10);
    expect(toLineSeries(decimation).y.slice(3, 6)).toEqual([undefined, undefined, undefined]);
  });

  test('report the span of the history', () => {
    const store = makeStore();

    expect(store.timeRange()).toBeUndefined();

    store.openEpoch({ epochId: 1, groupId: 0, variables: [{ id: 1, type: TypeCode.F32 }] });
    streamSingle(store, 1, 0, 10, (index) => 5 * MS + index * MS);
    store.openEpoch({ epochId: 2, groupId: 1, variables: [{ id: 2, type: TypeCode.F32 }] });
    streamSingle(store, 2, 0, 10, (index) => 50 * MS + index * MS);

    expect(store.timeRange(1)).toEqual({ startUs: 5 * MS, endUs: 14 * MS });
    expect(store.timeRange()).toEqual({ startUs: 5 * MS, endUs: 59 * MS });
  });
});
