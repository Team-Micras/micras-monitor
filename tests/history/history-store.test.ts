import { describe, expect, test, vi } from 'vitest';

import type { ValueType } from '@/core/variables';
import { COLUMN_BREAKS, COLUMN_HAS_DATA } from '@/history/decimation';
import { GAP_BYTES } from '@/history/gap-log';
import { HistoryStore, type HistoryStoreOptions } from '@/history/history-store';
import type { HistoryVariable, RecordingRecord, StoreWarning, VariableSpec } from '@/history/types';
import { ManualScheduler } from '@/history';
import { toLineSeries } from '@/ui/windows/plot/line-series';

const MS = 1000;
const SECOND = 1_000_000;

function makeStore(options: Partial<HistoryStoreOptions> = {}): HistoryStore {
  return new HistoryStore({ scheduler: new ManualScheduler(), blockSize: 256, ...options });
}

function mode(type: ValueType): HistoryVariable[] {
  return [{ id: 0, name: 'mode', type }];
}

function single(store: HistoryStore, runId: number, id = 1, slot = 0): void {
  store.openRun({ runId, slot, variables: [{ id, type: 'f32' }] });
}

function streamSingle(
  store: HistoryStore,
  runId: number,
  from: number,
  count: number,
  timeOf: (index: number) => number,
  valueOf: (index: number) => number = (index) => index
): void {
  for (let index = from; index < from + count; index++) {
    store.append(runId, timeOf(index), [valueOf(index)]);
  }
}

function threeEpochs(): HistoryStore {
  const store = makeStore();
  single(store, 1, 7);
  streamSingle(store, 1, 0, 1000, (index) => index * MS);
  single(store, 2, 7);
  streamSingle(store, 2, 0, 500, (index) => 2 * SECOND + index * MS);
  store.append(2, 2 * SECOND + 510 * MS, [510], 10);
  streamSingle(store, 2, 511, 489, (index) => 2 * SECOND + index * MS);
  store.markBoundary('reconnect', 3.5 * SECOND);
  single(store, 3, 7);
  streamSingle(store, 3, 0, 500, (index) => 4 * SECOND + index * MS);
  return store;
}

function stored(store: HistoryStore, id: number) {
  const runs = [...store.samples(id, 0, SECOND)];
  expect(runs).toHaveLength(1);
  return runs[0].values;
}

function breaksOf(store: HistoryStore, id: number, endUs: number, pixels: number): number[] {
  const decimation = store.decimate(id, 0, endUs, pixels);
  return Array.from({ length: pixels }, (_, column) => column).filter(
    (column) => (decimation.flags[column] & COLUMN_BREAKS) !== 0
  );
}

describe('runs and gaps', () => {
  test('tells time outside any run from samples dropped inside one', () => {
    const store = threeEpochs();

    expect(store.gaps(7, 0, 5 * SECOND)).toEqual([
      { kind: 'not-streamed', startUs: 999 * MS, endUs: 2 * SECOND },
      { kind: 'dropped', startUs: 2 * SECOND + 499 * MS, endUs: 2 * SECOND + 510 * MS, count: 10 },
      { kind: 'not-streamed', startUs: 2 * SECOND + 999 * MS, endUs: 4 * SECOND },
    ]);
    expect(store.boundaries()).toEqual([{ kind: 'reconnect', timeUs: 3.5 * SECOND }]);
    expect(store.variable(7)).toMatchObject({ storedSamples: 2490, droppedSamples: 10, runs: 3 });
  });

  test('counts the samples the source lost before one, even the first of a run', () => {
    const store = makeStore();
    single(store, 1, 1);
    store.append(1, 0, [1]);
    single(store, 2, 2, 1);
    store.append(2, 0, [1], 3);

    expect(store.variable(1)?.droppedSamples).toBe(0);
    expect(store.variable(2)?.droppedSamples).toBe(3);
  });

  test('leaves a repeated time out of the history, and a time going back too, with an event', () => {
    const store = makeStore();
    const events: StoreWarning[] = [];
    store.onWarning((warning) => events.push(warning));
    single(store, 1);
    store.append(1, 0, [1]);
    store.append(1, MS, [2]);
    store.append(1, MS, [3]);

    expect(store.latest(1)?.value).toBe(3);

    store.append(1, 0.5 * MS, [4]);
    store.append(1, 2 * MS, [5]);

    expect(store.variable(1)).toMatchObject({ storedSamples: 3, droppedSamples: 0 });
    expect(store.latest(1)?.value).toBe(5);
    expect(events).toEqual([{ type: 'time-backwards', runId: 1, timeUs: 0.5 * MS, lastUs: MS }]);
  });

  test('leaves out the loss a stale sample reports', () => {
    const store = makeStore();
    single(store, 1);
    streamSingle(store, 1, 0, 11, (index) => index * MS);
    store.append(1, 3 * MS, [3], 5);
    store.append(1, 11 * MS, [11]);

    expect(store.variable(1)).toMatchObject({ storedSamples: 12, droppedSamples: 0 });
  });

  test('counts the gap records against the memory cap', () => {
    const store = makeStore();
    single(store, 1);
    store.append(1, 0, [0]);
    const before = store.status().usedBytes;
    store.append(1, MS, [1], 4);
    store.append(1, 2 * MS, [2], 3);

    expect(store.status().usedBytes - before).toBe(2 * GAP_BYTES);
  });

  test('breaks the line between runs, at drops and at boundaries, and nowhere else', () => {
    const store = threeEpochs();
    const pixels = 500;
    const decimation = store.decimate(7, 0, 5 * SECOND, pixels);

    expect(breaksOf(store, 7, 5 * SECOND, pixels)).toEqual([99, 249, 299, 350]);

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

  test('does not break the line at a drop narrower than a pixel', () => {
    const store = makeStore();
    single(store, 1);

    for (let index = 0; index < 3000; index++) {
      if (index % 150 !== 75) {
        store.append(1, index * MS, [Math.sin(index)], index % 150 === 76 ? 1 : 0);
      }
    }

    expect(breaksOf(store, 1, 3 * SECOND, 30)).toEqual([]);
    expect(breaksOf(store, 1, 3 * SECOND, 3000)).toHaveLength(20);
  });
});

describe('run lifecycle', () => {
  test('closes an open run sharing a variable with a new one, whatever the ack order', () => {
    const store = makeStore();
    const scheduler = new ManualScheduler();
    const watched = new HistoryStore({ scheduler, blockSize: 256 });

    for (const target of [store, watched]) {
      target.openRun({
        runId: 1,
        slot: 0,
        variables: [
          { id: 1, type: 'f32' },
          { id: 2, type: 'f32' },
        ],
      });
    }

    const versionBefore = watched.version(2);
    single(store, 2, 1, 1);
    single(watched, 2, 1, 1);

    expect(() => store.append(1, 0, [1, 2])).toThrow('closed');
    expect(() => store.append(2, 0, [1])).not.toThrow();
    expect(watched.version(2)).toBeGreaterThan(versionBefore);
  });

  test('closes a run when its slot is disabled, once', () => {
    const store = makeStore();
    const events: RecordingRecord[] = [];
    store.follow((record) => events.push(record));
    single(store, 1);
    store.append(1, 0, [1]);
    store.closeRun(1);
    store.closeRun(1);

    expect(() => store.append(1, MS, [1])).toThrow('closed');
    expect(() => store.closeRun(9)).toThrow('No run 9');
    expect(events.map(({ kind }) => kind)).toEqual(['run', 'run-closed']);
  });

  test('closes the open run of a slot when the slot is defined again', () => {
    const store = makeStore();
    single(store, 1, 1, 2);
    single(store, 2, 2, 3);
    single(store, 3, 1, 2);

    expect(() => store.append(1, 0, [1])).toThrow('closed');
    expect(() => store.append(2, 0, [1])).not.toThrow();
    expect(() => store.append(9, 0, [1])).toThrow('No run 9');
    expect(() => store.append(3, 0, [1, 2])).toThrow(RangeError);
    expect(() => single(store, 3, 5, 1)).toThrow('already');
  });
});

describe('schema', () => {
  test('keys history by name, so it survives new ids after a reboot', () => {
    const store = makeStore();
    store.setSchema([{ id: 4, name: 'battery', type: 'f32' }]);
    single(store, 1, 4);
    streamSingle(
      store,
      1,
      0,
      10,
      (index) => index * MS,
      () => 7.5
    );
    store.markBoundary('reboot', 20 * MS);
    store.setSchema([
      { id: 0, name: 'state', type: 'u8' },
      { id: 9, name: 'battery', type: 'f32' },
    ]);
    single(store, 2, 9);
    streamSingle(
      store,
      2,
      0,
      10,
      (index) => 30 * MS + index * MS,
      () => 7.25
    );

    expect(store.variable('battery')).toMatchObject({ storedSamples: 20, runs: 2 });
    expect(store.historyMark(9)).toBe(store.historyMark('battery'));
    expect(store.variable(4)).toBeUndefined();
    expect([...store.samples('battery', 0, SECOND)].map((run) => run.values[0])).toEqual([
      7.5, 7.25,
    ]);
  });

  test('starts a new history, with a boundary, when a name comes back with another type', () => {
    const store = makeStore();
    store.setSchema([{ id: 0, name: 'mode', type: 'u8' }]);
    single(store, 1, 0);
    streamSingle(store, 1, 0, 10, (index) => index * MS);
    store.setSchema([{ id: 0, name: 'mode', type: 'u16' }]);
    store.openRun({ runId: 2, slot: 0, variables: [{ id: 0, type: 'u16' }] });
    store.append(2, 50 * MS, [3]);

    expect(store.variable('mode')).toMatchObject({ type: 'u16', storedSamples: 1 });
    expect(store.boundaries()).toEqual([{ kind: 'schema', timeUs: 9 * MS }]);
    expect([...store.samples('mode', 0, SECOND)].map((run) => Array.from(run.values))).toEqual([
      [3],
    ]);
    expect(store.timeRange()?.startUs).toBe(0);
  });

  test('starts a new history when a run names a known variable with another type', () => {
    const scheduler = new ManualScheduler();
    const store = new HistoryStore({ scheduler, blockSize: 256 });
    const callback = vi.fn<() => void>();
    store.setSchema([{ id: 0, name: 'mode', type: 'u8' }]);
    store.subscribe(['mode'], callback);
    single(store, 1, 0);
    streamSingle(store, 1, 0, 10, (index) => index * MS);
    const before = store.historyMark('mode');
    store.openRun({ runId: 2, slot: 0, variables: [{ id: 0, type: 'i32' }] });
    store.append(2, 50 * MS, [-3]);
    scheduler.flush();

    expect(store.variable('mode')).toMatchObject({ type: 'i32', storedSamples: 1 });
    expect(store.historyMark('mode')?.source).not.toBe(before?.source);
    expect(store.boundaries()).toEqual([{ kind: 'schema', timeUs: 9 * MS }]);
    expect(callback).toHaveBeenCalledTimes(1);
  });

  test('goes back to the history of a type that returns, and keeps the other reachable', () => {
    const store = makeStore();
    store.setSchema(mode('f32'));
    single(store, 1, 0);
    streamSingle(store, 1, 0, 10, (index) => index * MS);
    store.setSchema(mode('u8'));
    store.openRun({ runId: 2, slot: 0, variables: mode('u8') });
    store.append(2, 20 * MS, [7]);
    store.setSchema(mode('f32'));
    single(store, 3, 0);
    store.append(3, 30 * MS, [1.5]);

    expect(store.variable('mode')).toMatchObject({
      type: 'f32',
      storedSamples: 11,
      runs: 2,
    });
    expect(store.variable({ name: 'mode', type: 'u8' })).toMatchObject({
      type: 'u8',
      storedSamples: 1,
    });
    expect(store.boundaries().map(({ timeUs }) => timeUs)).toEqual([9 * MS, 20 * MS]);

    store.reset();

    expect(store.variable({ name: 'mode', type: 'u8' })?.storedSamples).toBe(0);
    expect(store.variable('mode')?.storedSamples).toBe(0);
  });

  test('names variables after their ids without a schema', () => {
    const store = makeStore();
    single(store, 1, 5);
    store.append(1, 0, [1]);

    expect(store.historyMark('#5')).toBe(store.historyMark(5));
  });
});

describe('numeric types', () => {
  const variables: readonly VariableSpec[] = [
    { id: 0, type: 'bool' },
    { id: 1, type: 'u16' },
    { id: 2, type: 'f32' },
    { id: 3, type: 'u32' },
    { id: 4, type: 'i32' },
    { id: 5, type: 'f64' },
    { id: 6, type: 'u64' },
    { id: 7, type: 'i64' },
    { id: 8, type: 'bytes' },
  ];

  test('keeps narrow types in 32 bit floats and the rest in 64 bit floats', () => {
    const store = makeStore();
    store.openRun({ runId: 1, slot: 0, variables });
    store.append(1, 0, [
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
    store.append(1, MS, [false, 1, 1.5, 16_777_217, 16_777_217, 1 / 3, 1n, 1n, new Uint8Array()]);

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
    const events: StoreWarning[] = [];
    store.onWarning((warning) => events.push(warning));
    store.openRun({ runId: 1, slot: 0, variables: variables.slice(6, 8) });
    store.append(1, 0, [2n ** 53n + 1n, -(2n ** 60n) - 3n]);
    store.append(1, MS, [2n ** 64n - 1n, 0n]);

    expect(store.variable(6)?.precisionLost).toBe(true);
    expect(store.variable(7)?.precisionLost).toBe(true);
    expect(events).toEqual([
      { type: 'precision-loss', name: '#6' },
      { type: 'precision-loss', name: '#7' },
    ]);
    expect(store.latest(6)?.value).toBe(2n ** 64n - 1n);
    expect(stored(store, 6)[0]).toBe(2 ** 53);
  });

  test('keeps blobs and read values as latest values, with a short history for blobs', () => {
    const store = makeStore({ historyLength: 3 });
    store.openRun({ runId: 1, slot: 0, variables: variables.slice(7) });

    for (let index = 0; index < 5; index++) {
      store.append(1, index * MS, [BigInt(index), new Uint8Array([index])]);
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
    store.openRun({
      runId: 1,
      slot: 0,
      variables: [
        { id: 1, type: 'f32' },
        { id: 2, type: 'u32' },
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
      store.append(1, index, [index, index]);
    }

    const before = buffers();

    for (let index = 3 * blockSize + 10; index < 40 * blockSize; index++) {
      store.append(1, index, [index, index]);
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
    single(store, 1);
    streamSingle(store, 1, 0, 12_000, (index) => index);

    expect([...store.samples(1, 0, 12_000)].map((run) => run.time.buffer.byteLength / 8)).toEqual([
      1024, 2048, 4096, 4096, 4096,
    ]);
  });

  test('hand out runs as views, split at block edges, for the asked range only', () => {
    const store = makeStore({ blockSize: 256 });
    store.openRun({ runId: 1, slot: 0, variables: [{ id: 1, type: 'f64' }] });
    streamSingle(store, 1, 0, 1000, (index) => index * MS);
    const runs = [...store.samples(1, 100 * MS, 700 * MS)];

    expect(runs.map((run) => run.time.length)).toEqual([156, 256, 188]);
    expect(runs[0].time[0]).toBe(100 * MS);
    expect(runs[2].values.at(-1)).toBe(699);
    expect(runs.every((run) => run.runId === 1)).toBe(true);
  });
});

describe('queries', () => {
  test('mark a column without samples as neither data nor gap', () => {
    const store = makeStore();
    single(store, 1);
    streamSingle(store, 1, 0, 10, (index) => index * 100 * MS);
    const decimation = store.decimate(1, 0, SECOND, 100);
    const data = Array.from(decimation.flags.subarray(0, 100), (flags) => flags & COLUMN_HAS_DATA);

    expect(data.filter(Boolean)).toHaveLength(10);
    expect(toLineSeries(decimation).y.slice(3, 6)).toEqual([undefined, undefined, undefined]);
  });

  test('report the span of the history as a half-open range, the same object until it grows', () => {
    const store = makeStore();

    expect(store.timeRange()).toBeUndefined();

    single(store, 1, 1, 0);
    streamSingle(store, 1, 0, 10, (index) => 5 * MS + index * MS);
    single(store, 2, 2, 1);
    streamSingle(store, 2, 0, 10, (index) => 50 * MS + index * MS);
    const range = store.timeRange(1);

    expect(range?.startUs).toBe(5 * MS);
    expect(range?.endUs).toBeGreaterThan(14 * MS);
    expect(range?.endUs).toBeLessThan(14 * MS + 1e-6);
    expect(store.timeRange(1)).toBe(range);
    expect(store.timeRange()).toBe(store.timeRange());
    expect([...store.samples(1, range?.startUs ?? 0, range?.endUs ?? 0)][0].time).toHaveLength(10);

    store.append(1, 20 * MS, [1]);

    expect(store.timeRange(1)).not.toBe(range);
  });

  test('find the sample at or before a time, for synced cursors', () => {
    const store = makeStore();
    single(store, 1);
    streamSingle(
      store,
      1,
      0,
      1000,
      (index) => index * MS,
      (index) => index * 2
    );

    expect(store.valueAt(1, 500 * MS)).toEqual({ value: 1000, timeUs: 500 * MS });
    expect(store.valueAt(1, 500.5 * MS)).toEqual({ value: 1000, timeUs: 500 * MS });
    expect(store.valueAt(1, 5 * SECOND)).toEqual({ value: 1998, timeUs: 999 * MS });
    expect(store.valueAt(1, -1)).toBeUndefined();
  });

  test('tell a paused window whether live samples changed it', () => {
    const store = makeStore();
    single(store, 1);
    streamSingle(store, 1, 0, 100, (index) => index * MS);
    const mark = store.historyMark(1);
    streamSingle(store, 1, 100, 10, (index) => index * MS);

    expect(store.changedSince(1, mark, { startUs: 0, endUs: 50 * MS })).toBe(false);
    expect(store.changedSince(1, mark, { startUs: 0, endUs: 105 * MS })).toBe(true);
    expect(store.changedSince(1, store.historyMark(1), { startUs: 0, endUs: SECOND })).toBe(false);

    store.markBoundary('reconnect', 10 * MS);

    expect(store.changedSince(1, mark, { startUs: 0, endUs: 50 * MS })).toBe(true);
  });

  test('forget the history on reset, and carry on with the open runs', () => {
    const store = makeStore();
    single(store, 1, 1, 0);
    streamSingle(store, 1, 0, 600, (index) => index * MS);
    single(store, 2, 2, 1);
    store.append(2, 0, [1]);
    store.closeRun(2);
    store.markBoundary('reconnect', SECOND);
    single(store, 3, 1, 0);
    streamSingle(store, 3, 0, 10, (index) => 2 * SECOND + index * MS);
    expect(store.resetCount).toBe(0);
    store.reset();

    expect(store.resetCount).toBe(1);
    expect(store.variable(1)).toMatchObject({ storedSamples: 0, runs: 1 });
    expect(store.boundaries()).toEqual([]);
    expect(store.status().usedBytes).toBe(0);
    expect(store.latest(1)?.value).toBe(9);

    streamSingle(store, 3, 10, 5, (index) => 2 * SECOND + index * MS);

    expect(store.variable(1)?.storedSamples).toBe(5);
    expect(store.variable(1)?.droppedSamples).toBe(0);
  });
});

describe('what a recording follows', () => {
  test('is the runs, final gaps, boundaries and values, so far and as they come', () => {
    const store = makeStore();
    const events: RecordingRecord[] = [];
    store.follow((record) => events.push(record));
    store.setSchema([
      { id: 0, name: 'speed', type: 'f32' },
      { id: 1, name: 'maze', type: 'bytes' },
    ]);
    single(store, 1, 0);
    store.append(1, 0, [1]);
    store.append(1, MS, [1], 4);
    store.append(1, 2 * MS, [1]);
    store.append(1, 3 * MS, [1], 2);

    expect(events.filter(({ kind }) => kind === 'gap')).toHaveLength(2);

    store.setLatestValue(1, new Uint8Array([7]), 3 * MS);
    store.markBoundary('reboot', 4 * MS);

    expect(events).toEqual([
      {
        kind: 'run',
        run: {
          runId: 1,
          slot: 0,
          variables: [{ id: 0, name: 'speed', type: 'f32' }],
        },
      },
      {
        kind: 'gap',
        gap: {
          runId: 1,
          kind: 'dropped',
          index: 1,
          count: 4,
          startUs: 0,
          afterUs: 0,
          untilUs: MS,
        },
      },
      {
        kind: 'gap',
        gap: {
          runId: 1,
          kind: 'dropped',
          index: 3,
          count: 2,
          startUs: 2 * MS,
          afterUs: 2 * MS,
          untilUs: 3 * MS,
        },
      },
      {
        kind: 'value',
        value: { variableId: 1, name: 'maze', timeUs: 3 * MS, value: new Uint8Array([7]) },
      },
      { kind: 'boundary', boundary: { kind: 'reboot', timeUs: 4 * MS } },
      { kind: 'run-closed', runId: 1 },
    ]);

    const replayed: RecordingRecord[] = [];
    store.follow((record) => replayed.push(record));

    expect(replayed.map(({ kind }) => kind)).toEqual([
      'run',
      'gap',
      'gap',
      'run-closed',
      'boundary',
      'value',
    ]);
  });
});
