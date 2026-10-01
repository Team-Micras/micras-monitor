import { describe, expect, test, vi } from 'vitest';

import { Block } from '@/telemetry/block';
import { referenceDecimation, type ReferenceSample } from '@tests/support/telemetry/reference';
import type { BlockPersistence, BlockRef, PersistedBlock } from '@/telemetry/persistence';
import { TelemetryStore, type TelemetryStoreOptions } from '@/telemetry/store';
import type { TelemetryEvent, VariableSpec } from '@/telemetry/types';
import { MemoryBlockPersistence } from '@tests/support/telemetry/memory-persistence';
import { ManualScheduler } from '@/telemetry';

const BLOCK_SIZE = 1024;
const VARIABLES: readonly VariableSpec[] = [
  { id: 1, type: 'f32' },
  { id: 2, type: 'f64' },
];
const BLOCK_BYTES = Block.byteLengthFor({ capacity: BLOCK_SIZE, kinds: ['f32', 'f64'] });

function settle(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

function cappedStore(blocks: number, options: Partial<TelemetryStoreOptions> = {}) {
  const scheduler = new ManualScheduler();
  const store = new TelemetryStore({
    scheduler,
    blockSize: BLOCK_SIZE,
    memoryCapBytes: blocks * BLOCK_BYTES,
    ...options,
  });
  const events: TelemetryEvent[] = [];
  store.onEvent((event) => events.push(event));
  store.openEpoch({ epochId: 1, groupId: 0, variables: VARIABLES });
  return { scheduler, store, events };
}

function valueAt(index: number): number {
  return Math.fround(Math.sin(index / 97) * 10);
}

function appendRange(store: TelemetryStore, from: number, to: number): void {
  for (let index = from; index < to; index++) {
    store.append(1, index & 0xffff, index * 1000, [valueAt(index), index]);
  }
}

async function streamBlocks(store: TelemetryStore, first: number, end: number): Promise<void> {
  if (first >= end) {
    return;
  }

  appendRange(store, first * BLOCK_SIZE, (first + 1) * BLOCK_SIZE);
  await settle();
  return streamBlocks(store, first + 1, end);
}

async function frames(count: number, frame: () => void, scheduler: ManualScheduler) {
  if (count === 0) {
    return;
  }

  frame();
  scheduler.flush();
  await settle();
  return frames(count - 1, frame, scheduler);
}

function types(events: readonly TelemetryEvent[]): string[] {
  return events.map(({ type }) => type);
}

describe('memory cap without recording', () => {
  test('warns at 80 %, then lets go of the oldest blocks and never stops keeping new ones', () => {
    const { store, events } = cappedStore(5);
    appendRange(store, 0, 4 * BLOCK_SIZE);

    expect(events).toEqual([
      { type: 'memory-warning', usedBytes: 4 * BLOCK_BYTES, capBytes: 5 * BLOCK_BYTES },
    ]);

    appendRange(store, 4 * BLOCK_SIZE, 9 * BLOCK_SIZE);
    const kept = store.variable(1)?.storedSamples ?? 0;
    const firstKept = (9 * BLOCK_SIZE - kept) * 1000;

    expect(types(events).filter((type) => type === 'history-dropped').length).toBeGreaterThan(2);
    expect(types(events)).not.toContain('history-stopped');
    expect(store.status()).toMatchObject({ historyStopped: false, evictedBlocks: 0 });
    expect(store.status().usedBytes).toBeLessThanOrEqual(5 * BLOCK_BYTES);
    expect(kept % BLOCK_SIZE).toBe(0);
    expect(store.latest(2)).toEqual({
      value: 9 * BLOCK_SIZE - 1,
      timeUs: (9 * BLOCK_SIZE - 1) * 1000,
    });
    expect(store.gaps(1, 0, Number.POSITIVE_INFINITY)).toEqual([
      { kind: 'not-stored', startUs: 0, endUs: firstKept, count: 9 * BLOCK_SIZE - kept },
    ]);
    expect([...store.samples(1, 0, Number.POSITIVE_INFINITY)][0].time[0]).toBe(firstKept);
  });

  test('keeps the pyramids of what it still holds consistent with the samples', () => {
    const { store } = cappedStore(3);
    appendRange(store, 0, 8 * BLOCK_SIZE);
    const range = store.timeRange(1);
    const samples: ReferenceSample[] = [];

    for (const run of store.samples(1, 0, Number.POSITIVE_INFINITY)) {
      run.time.forEach((timeUs, index) => samples.push({ timeUs, value: run.values[index] }));
    }

    const decimation = store.decimate(1, range?.startUs ?? 0, range?.endUs ?? 1, 100);

    expect(Array.from(decimation.min.subarray(0, 100))).toEqual(
      referenceDecimation(samples, range?.startUs ?? 0, range?.endUs ?? 1, 100).min
    );
  });
  test('closes the gap left by dropping the newest block once the next sample is kept', () => {
    const { store } = cappedStore(1.5);
    const finalGaps: unknown[] = [];
    store.onIngestion((event) => {
      if (event.type === 'gap') {
        finalGaps.push(event.gap);
      }
    });
    appendRange(store, 0, 3000);
    const firstKept = [...store.samples(1, 0, Number.POSITIVE_INFINITY)][0].time[0];

    expect(firstKept).toBe(2048 * 1000);
    expect(store.gaps(1, 2_500_000, 2_600_000)).toEqual([]);
    expect(store.gaps(1, 0, Number.POSITIVE_INFINITY)).toEqual([
      { kind: 'not-stored', startUs: 0, endUs: firstKept, count: 2048 },
    ]);
    expect(finalGaps.at(-1)).toMatchObject({ kind: 'not-stored', index: 2048, untilUs: firstKept });
  });
});

describe('memory cap while recording', () => {
  test('evicts written blocks and keeps every sample', async () => {
    const { store, events } = cappedStore(4);
    const persistence = new MemoryBlockPersistence();
    store.startRecording(persistence);
    await streamBlocks(store, 0, 12);

    expect(events).toEqual([]);
    expect(persistence.writes).toBe(12);
    expect(store.variable(1)?.storedSamples).toBe(12 * BLOCK_SIZE);
    expect(store.status()).toMatchObject({ recording: true, historyStopped: false });
    expect(store.status().usedBytes).toBeLessThanOrEqual(4 * BLOCK_BYTES);
    expect(store.status().evictedBlocks).toBeGreaterThanOrEqual(8);
    expect(store.status().residentBlocks + store.status().evictedBlocks).toBe(12);
  });

  test('brings evicted blocks back once the tick ends, and tells subscribers', async () => {
    const { scheduler, store } = cappedStore(4);
    const persistence = new MemoryBlockPersistence();
    store.startRecording(persistence);
    await streamBlocks(store, 0, 8);
    const callback = vi.fn<() => void>();
    store.subscribe([1], callback);
    scheduler.flush();
    callback.mockClear();

    expect([...store.samples(1, 0, BLOCK_SIZE * 1000)]).toEqual([]);

    scheduler.flush();
    await settle();
    scheduler.flush();
    const runs = [...store.samples(1, 0, BLOCK_SIZE * 1000)];

    expect(persistence.reads).toBe(1);
    expect(callback).toHaveBeenCalledTimes(1);
    expect(runs).toHaveLength(1);
    expect(Array.from(runs[0].values)).toEqual(
      Array.from({ length: BLOCK_SIZE }, (_, index) => valueAt(index))
    );
    expect(store.status().usedBytes).toBeLessThanOrEqual(4 * BLOCK_BYTES);
  });

  test('evicts the blocks no query read before those one did', async () => {
    const { scheduler, store } = cappedStore(4);
    const persistence = new MemoryBlockPersistence();
    store.startRecording(persistence);
    const firstBlock = () => [...store.samples(1, 0, BLOCK_SIZE * 1000)];
    await streamBlocks(store, 0, 6);

    expect(firstBlock()).toEqual([]);

    scheduler.flush();
    await settle();

    expect(firstBlock()).toHaveLength(1);

    await streamBlocks(store, 6, 9);

    expect(firstBlock()).toHaveLength(1);
    expect(persistence.reads).toBe(1);
  });

  test('settles when the blocks a view needs do not fit, instead of reading them over and over', async () => {
    const { scheduler, store } = cappedStore(5);
    const persistence = new MemoryBlockPersistence();
    store.startRecording(persistence);
    await streamBlocks(store, 0, 16);
    const reads: number[] = [];
    const endUs = 8 * BLOCK_SIZE * 1000;

    await frames(
      20,
      () => {
        store.decimate(1, 0, endUs, 8 * BLOCK_SIZE);
        reads.push(persistence.reads);
      },
      scheduler
    );

    expect(reads.at(-1)).toBeGreaterThan(0);
    expect(reads.at(-1)).toBeLessThan(8);
    expect(reads.at(-1)).toBe(reads[2]);
    expect(store.status().usedBytes).toBeLessThanOrEqual(5 * BLOCK_BYTES);
  });

  test('does not evict for a read back that would not fit even then', async () => {
    const { scheduler, store } = cappedStore(4);
    const persistence = new MemoryBlockPersistence();
    store.startRecording(persistence);
    await streamBlocks(store, 0, 6);
    appendRange(store, 6 * BLOCK_SIZE, 6 * BLOCK_SIZE + 100);
    await store.stopRecording();
    store.decimate(1, 6 * BLOCK_SIZE * 1000, 7 * BLOCK_SIZE * 1000, 1000);
    scheduler.flush();
    await settle();
    const evicted = store.status().evictedBlocks;
    const reads = persistence.reads;

    await frames(3, () => store.decimate(1, 0, 6 * BLOCK_SIZE * 1000, 6 * BLOCK_SIZE), scheduler);

    expect(persistence.reads).toBe(reads + 1);
    expect(store.status().evictedBlocks).toBe(evicted - 1);
  });

  test('answers coarse queries on evicted blocks from their pyramids alone', async () => {
    const { store } = cappedStore(3);
    const persistence = new MemoryBlockPersistence();
    store.startRecording(persistence);
    await streamBlocks(store, 0, 10);
    const samples = Array.from({ length: 10 * BLOCK_SIZE }, (_, index) => ({
      timeUs: index * 1000,
      value: valueAt(index),
    }));
    const endUs = 10 * BLOCK_SIZE * 1000;
    const decimation = store.decimate(1, 0, endUs, 40);
    const reference = referenceDecimation(samples, 0, endUs, 40);
    const min = Array.from(decimation.min.subarray(0, 40));

    expect(persistence.reads).toBe(0);
    expect(Math.min(...min)).toBe(Math.min(...reference.min));
    expect(Math.max(...decimation.max.subarray(0, 40))).toBe(Math.max(...reference.max));
    min.forEach((value, column) => {
      expect(Math.abs(value - reference.min[column])).toBeLessThan(0.2);
    });
  });

  test('does not spill the leaf before a window into its first column', async () => {
    const { store } = cappedStore(3);
    const persistence = new MemoryBlockPersistence();
    store.startRecording(persistence);
    await streamBlocks(store, 0, 6);
    const decimation = store.decimate(2, 320_000, 640_000, 4);

    expect(decimation.min[0]).toBe(320);
  });

  test('goes one block over the cap rather than lose samples to a pending write', async () => {
    const { store, events } = cappedStore(2);
    store.startRecording(new MemoryBlockPersistence());
    appendRange(store, 0, 2 * BLOCK_SIZE + 1);

    expect(events).toEqual([]);
    expect(store.variable(1)?.storedSamples).toBe(2 * BLOCK_SIZE + 1);
    expect(store.status().usedBytes).toBeGreaterThan(2 * BLOCK_BYTES);

    await settle();

    expect(store.status().usedBytes).toBeLessThanOrEqual(2 * BLOCK_BYTES);
  });

  test('brings back a block for a window narrower than a pyramid leaf', async () => {
    const { scheduler, store } = cappedStore(3);
    const persistence = new MemoryBlockPersistence();
    store.startRecording(persistence);
    await streamBlocks(store, 0, 6);
    const window = [20_000, 28_000] as const;
    const approximate = store.decimate(1, ...window, 100);

    expect(Array.from(approximate.flags.subarray(0, 100)).filter(Boolean)).toHaveLength(1);

    scheduler.flush();
    await settle();
    const decimation = store.decimate(1, ...window, 100);

    expect(persistence.reads).toBe(1);
    expect(Array.from(decimation.flags.subarray(0, 100)).filter(Boolean)).toHaveLength(8);
  });

  test('does not read a block back when there is no room for it', async () => {
    const { scheduler, store } = cappedStore(4);
    const persistence = new MemoryBlockPersistence();
    store.startRecording(persistence);
    await streamBlocks(store, 0, 6);
    await store.stopRecording();
    await streamBlocks(store, 6, 12);
    await frames(5, () => store.decimate(1, 0, 100_000, 1000), scheduler);

    expect(persistence.reads).toBe(0);
  });
});

describe('writing while recording', () => {
  test('seals and writes the block being filled every 5 s, and on stop', async () => {
    let clock = 0;
    const { store } = cappedStore(100, { now: () => clock });
    const persistence = new MemoryBlockPersistence();
    store.startRecording(persistence);
    appendRange(store, 0, 100);
    clock = 5000;
    appendRange(store, 100, 101);
    await settle();

    expect(persistence.writes).toBe(1);
    expect([...store.samples(1, 0, 1)][0].time.buffer.byteLength).toBe(101 * 8);

    appendRange(store, 101, 300);
    clock = 7000;
    appendRange(store, 300, 301);
    await settle();

    expect(persistence.writes).toBe(1);

    await store.stopRecording();

    expect(persistence.writes).toBe(2);
    expect(persistence.has({ epochId: 1, index: 1 })).toBe(true);
    expect(
      [...store.samples(1, 0, Number.POSITIVE_INFINITY)].map((run) => run.time.length)
    ).toEqual([101, 200]);
  });

  test('writes the whole session so far when recording starts, the block being filled too', async () => {
    const { store } = cappedStore(100);
    appendRange(store, 0, 3 * BLOCK_SIZE + 100);
    const persistence = new MemoryBlockPersistence();
    store.startRecording(persistence);
    await settle();
    const back = await Promise.all(
      [0, 1, 2, 3].map((index) => persistence.read({ epochId: 1, index }))
    );

    expect(persistence.size).toBe(4);
    expect(back.map((block) => block.time.length)).toEqual([
      BLOCK_SIZE,
      BLOCK_SIZE,
      BLOCK_SIZE,
      100,
    ]);
    expect(back[3].columns[1].values[99]).toBe(3 * BLOCK_SIZE + 99);

    appendRange(store, 3 * BLOCK_SIZE + 100, 3 * BLOCK_SIZE + 101);

    expect(store.variable(1)?.storedSamples).toBe(3 * BLOCK_SIZE + 101);
    expect([...store.samples(1, 0, Number.POSITIVE_INFINITY)]).toHaveLength(5);
  });

  test('writes the whole session so far when recording starts again', async () => {
    const { store } = cappedStore(4);
    const first = new MemoryBlockPersistence();
    store.startRecording(first);
    await streamBlocks(store, 0, 8);
    appendRange(store, 8 * BLOCK_SIZE, 8 * BLOCK_SIZE + 10);
    await store.stopRecording();
    const second = new MemoryBlockPersistence();
    const evicted = store.status().evictedBlocks;
    store.startRecording(second);
    await settle();
    await settle();

    expect(evicted).toBeGreaterThan(0);
    expect(second.size).toBe(9);
    expect(first.reads).toBe(evicted);
    expect(first.size).toBe(9);
  });

  test('waits on stop for a block being read back for the new recording', async () => {
    const { store } = cappedStore(4);
    const first = new MemoryBlockPersistence();
    store.startRecording(first);
    await streamBlocks(store, 0, 8);
    await store.stopRecording();
    const release: (() => void)[] = [];
    const read = first.read.bind(first);
    first.read = (ref) =>
      new Promise<void>((resolve) => release.push(resolve)).then(() => read(ref));
    const second = new MemoryBlockPersistence();
    store.startRecording(second);
    await settle();
    let stopped = false;
    const stop = store.stopRecording().then(() => {
      stopped = true;
    });
    await settle();

    expect(release).toHaveLength(1);
    expect(stopped).toBe(false);

    release.forEach((resolve) => resolve());
    await stop;

    expect(stopped).toBe(true);
    expect(first.reads).toBe(1);
  });

  test('keeps counting dropped samples in what it says of a variable while history is stopped', async () => {
    const stuck: BlockPersistence = {
      write: () => new Promise<void>(() => undefined),
      read: () => Promise.reject(new Error('never written')),
    };
    const { store, events } = cappedStore(2);
    store.startRecording(stuck);
    await streamBlocks(store, 0, 6);

    expect(types(events)).toContain('history-stopped');
    const before = store.variable(1);
    store.append(1, 7 * BLOCK_SIZE, 7 * BLOCK_SIZE * 1000, [1, 2]);
    const after = store.variable(1);

    expect(after?.droppedSamples).toBe((before?.droppedSamples ?? 0) + BLOCK_SIZE);
    expect(store.variable(1)).toBe(after);
  });

  test('tells about failing writes once, backs off, and recovers', async () => {
    let clock = 0;
    let failing = true;
    const memory = new MemoryBlockPersistence();
    const flaky: BlockPersistence = {
      write: (block: PersistedBlock) =>
        failing ? Promise.reject(new Error('disk full')) : memory.write(block),
      read: (ref: BlockRef) => memory.read(ref),
    };
    const { store, events } = cappedStore(3, { now: () => clock });
    store.startRecording(flaky);
    await streamBlocks(store, 0, 6);

    expect(types(events)).toEqual(['persistence-error', 'history-stopped']);
    expect(store.status()).toMatchObject({ persistenceFailing: true, historyStopped: true });

    failing = false;
    clock = 500;
    appendRange(store, 6 * BLOCK_SIZE, 6 * BLOCK_SIZE + 10);
    await settle();

    expect(memory.writes).toBe(0);

    clock = 6000;
    appendRange(store, 6 * BLOCK_SIZE + 10, 6 * BLOCK_SIZE + 20);
    await settle();
    appendRange(store, 6 * BLOCK_SIZE + 20, 6 * BLOCK_SIZE + 30);

    expect(types(events)).toEqual([
      'persistence-error',
      'history-stopped',
      'persistence-recovered',
      'history-resumed',
    ]);
    expect(store.status().persistenceFailing).toBe(false);
  });

  test('breaks the line of a view drawn while samples were not kept, once they are again', async () => {
    let clock = 0;
    let failing = true;
    const memory = new MemoryBlockPersistence();
    const flaky: BlockPersistence = {
      write: (block: PersistedBlock) =>
        failing ? Promise.reject(new Error('disk full')) : memory.write(block),
      read: (ref: BlockRef) => memory.read(ref),
    };
    const { store } = cappedStore(5, { now: () => clock });
    const other = (from: number, to: number) => {
      for (let index = from; index < to; index++) {
        store.append(2, index, index * 1000, [valueAt(index), index]);
      }
    };
    store.startRecording(flaky);
    await streamBlocks(store, 0, 4);
    store.openEpoch({
      epochId: 2,
      groupId: 1,
      variables: [
        { id: 3, type: 'f32' },
        { id: 4, type: 'f64' },
      ],
    });
    other(0, BLOCK_SIZE);
    await settle();
    other(BLOCK_SIZE, BLOCK_SIZE + 100);

    expect(store.status().historyStopped).toBe(true);

    const endUs = 2 * BLOCK_SIZE * 1000;
    const view = store.decimate(3, 0, endUs, 800);
    other(BLOCK_SIZE + 100, BLOCK_SIZE + 500);
    store.decimate(3, 0, endUs, 800, { into: view });
    const rewrite = store.historyMark(3)?.rewrite;
    failing = false;
    clock = 6000;
    other(BLOCK_SIZE + 500, BLOCK_SIZE + 510);
    await settle();
    await settle();
    other(BLOCK_SIZE + 510, BLOCK_SIZE + 600);

    expect(store.status().historyStopped).toBe(false);
    expect(store.gaps(3, 0, endUs)).toEqual([
      expect.objectContaining({ kind: 'not-stored', startUs: BLOCK_SIZE * 1000 }),
    ]);
    expect(store.historyMark(3)?.rewrite).toBe(rewrite);

    const incremental = store.decimate(3, 0, endUs, 800, { into: view });
    const fresh = store.decimate(3, 0, endUs, 800);

    expect(Array.from(incremental.flags.subarray(0, 800))).toEqual(
      Array.from(fresh.flags.subarray(0, 800))
    );
  });

  test('shows the samples an empty epoch could not keep as a gap', async () => {
    const failing: BlockPersistence = {
      write: () => Promise.reject(new Error('disk full')),
      read: () => Promise.reject(new Error('never written')),
    };
    const { store } = cappedStore(2);
    store.startRecording(failing);
    await streamBlocks(store, 0, 3);
    store.openEpoch({ epochId: 2, groupId: 1, variables: [{ id: 3, type: 'f32' }] });

    for (let index = 0; index < 5; index++) {
      store.append(2, index, 10_000_000 + index, [1]);
    }

    expect(store.gaps(3, 0, Number.POSITIVE_INFINITY)).toEqual([
      { kind: 'not-stored', startUs: 10_000_000, endUs: Number.NaN, count: 5 },
    ]);
  });
});

describe('short epochs', () => {
  test('take little memory, because an epoch starts with a small block', () => {
    const store = new TelemetryStore({ scheduler: new ManualScheduler() });
    const variables = Array.from({ length: 16 }, (_, id): VariableSpec => ({ id, type: 'f32' }));
    const row = Array.from({ length: 16 }, () => 1);

    for (let epoch = 0; epoch < 50; epoch++) {
      store.openEpoch({ epochId: epoch, groupId: 0, variables });

      for (let index = 0; index < 100; index++) {
        store.append(epoch, index, (epoch * 100 + index) * 1000, row);
      }
    }

    const compacted = Block.byteLengthFor({ capacity: 100, kinds: variables.map(() => 'f32') });

    expect(store.status().usedBytes).toBeLessThanOrEqual(50 * compacted + 16 * 1024 * 70);
    expect(store.variable(0)?.storedSamples).toBe(5000);
  });
});
