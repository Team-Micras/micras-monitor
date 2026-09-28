import { describe, expect, test, vi } from 'vitest';

import { TypeCode } from '@/protocol';

import { Block } from './block';
import { referenceDecimation, type ReferenceSample, withoutNanBounds } from './fixtures/reference';
import { MemoryBlockPersistence } from './memory-persistence';
import type { BlockPersistence } from './persistence';
import { ManualScheduler } from './scheduler';
import { TelemetryStore } from './store';
import type { TelemetryEvent } from './types';

const BLOCK_SIZE = 1024;
const VARIABLES = [
  { id: 1, type: TypeCode.F32 },
  { id: 2, type: TypeCode.F64 },
];
const BLOCK_BYTES = Block.byteLengthFor({ capacity: BLOCK_SIZE, kinds: ['f32', 'f64'] });

function settle(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

function cappedStore(blocks: number) {
  const scheduler = new ManualScheduler();
  const store = new TelemetryStore({
    scheduler,
    blockSize: BLOCK_SIZE,
    memoryCapBytes: blocks * BLOCK_BYTES,
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

describe('memory cap without recording', () => {
  test('warns at 80 %, then stops keeping history but keeps the latest values', () => {
    const { store, events } = cappedStore(5);
    appendRange(store, 0, 4 * BLOCK_SIZE);

    expect(events).toEqual([
      { type: 'memory-warning', usedBytes: 4 * BLOCK_BYTES, capBytes: 5 * BLOCK_BYTES },
    ]);

    appendRange(store, 4 * BLOCK_SIZE, 7 * BLOCK_SIZE);

    expect(events.map(({ type }) => type)).toEqual(['memory-warning', 'history-stopped']);
    expect(store.status()).toMatchObject({
      usedBytes: 5 * BLOCK_BYTES,
      historyStopped: true,
      residentBlocks: 5,
      evictedBlocks: 0,
    });
    expect(store.variable(1)?.storedSamples).toBe(5 * BLOCK_SIZE);
    expect(store.latest(2)).toEqual({
      value: 7 * BLOCK_SIZE - 1,
      timeUs: (7 * BLOCK_SIZE - 1) * 1000,
    });
  });

  test('shows the samples it could not keep as a gap', () => {
    const { store } = cappedStore(2);
    appendRange(store, 0, 3 * BLOCK_SIZE);
    const open = store.gaps(1, 0, Number.POSITIVE_INFINITY);
    store.markBoundary('reconnect', 3 * BLOCK_SIZE * 1000);

    expect(open).toEqual(store.gaps(1, 0, Number.POSITIVE_INFINITY));
    expect(store.gaps(1, 0, Number.POSITIVE_INFINITY)).toEqual([
      {
        kind: 'not-stored',
        startUs: (2 * BLOCK_SIZE - 1) * 1000,
        endUs: Number.NaN,
        count: BLOCK_SIZE,
      },
    ]);
  });
});

describe('memory cap while recording', () => {
  test('evicts persisted blocks and keeps every sample', async () => {
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

  test('brings evicted blocks back when a query needs their samples', async () => {
    const { scheduler, store } = cappedStore(4);
    const persistence = new MemoryBlockPersistence();
    store.startRecording(persistence);

    await streamBlocks(store, 0, 8);

    const callback = vi.fn<() => void>();
    store.subscribe([1], callback);
    scheduler.flush();
    callback.mockClear();

    expect([...store.samples(1, 0, BLOCK_SIZE * 1000)]).toEqual([]);

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
    const { store } = cappedStore(4);
    const persistence = new MemoryBlockPersistence();
    store.startRecording(persistence);
    const firstBlock = () => [...store.samples(1, 0, BLOCK_SIZE * 1000)];

    await streamBlocks(store, 0, 6);

    expect(firstBlock()).toEqual([]);

    await settle();

    expect(firstBlock()).toHaveLength(1);

    await streamBlocks(store, 6, 9);

    expect(firstBlock()).toHaveLength(1);
    expect(persistence.reads).toBe(1);
  });

  test('answers coarse queries on evicted blocks from their pyramids alone', async () => {
    const { store } = cappedStore(3);
    const persistence = new MemoryBlockPersistence();
    store.startRecording(persistence);
    const samples: ReferenceSample[] = [];

    await streamBlocks(store, 0, 10);

    for (let index = 0; index < 10 * BLOCK_SIZE; index++) {
      samples.push({ timeUs: index * 1000, value: valueAt(index) });
    }

    const endUs = 10 * BLOCK_SIZE * 1000;
    const decimation = store.decimate(1, 0, endUs, 40);
    const reference = referenceDecimation(samples, 0, endUs, 40);
    const found = withoutNanBounds({
      data: Array.from(decimation.flags.subarray(0, 40), (flags) => flags !== 0),
      nan: reference.nan,
      min: Array.from(decimation.min.subarray(0, 40)),
      max: Array.from(decimation.max.subarray(0, 40)),
    });

    expect(persistence.reads).toBe(0);
    expect(found.data).toEqual(reference.data);
    expect(Math.min(...found.min)).toBe(Math.min(...reference.min));
    expect(Math.max(...found.max)).toBe(Math.max(...reference.max));
    found.min.forEach((min, column) => {
      expect(Math.abs(min - reference.min[column])).toBeLessThan(0.2);
    });
  });

  test('evicts blocks sealed before recording started, once written', async () => {
    const { store, events } = cappedStore(3);
    appendRange(store, 0, 2 * BLOCK_SIZE + 10);
    store.startRecording(new MemoryBlockPersistence());
    await settle();
    appendRange(store, 2 * BLOCK_SIZE + 10, 4 * BLOCK_SIZE);

    expect(events.map(({ type }) => type)).toEqual(['memory-warning']);
    expect(store.status().evictedBlocks).toBe(2);
    expect(store.variable(1)?.storedSamples).toBe(4 * BLOCK_SIZE);
  });

  test('stops keeping history when writes fail, and says why', async () => {
    const { store, events } = cappedStore(2);
    const failing: BlockPersistence = {
      write: () => Promise.reject(new Error('disk full')),
      read: () => Promise.reject(new Error('never written')),
    };
    store.startRecording(failing);
    await streamBlocks(store, 0, 4);

    expect(new Set(events.map(({ type }) => type))).toEqual(
      new Set(['persistence-error', 'history-stopped'])
    );
    expect(store.status().historyStopped).toBe(true);
    expect(store.status().evictedBlocks).toBe(0);
  });

  test('goes one block over the cap rather than lose samples to a pending write', async () => {
    const { store, events } = cappedStore(2);
    const persistence = new MemoryBlockPersistence();
    store.startRecording(persistence);
    appendRange(store, 0, 2 * BLOCK_SIZE + 1);

    expect(events).toEqual([]);
    expect(store.variable(1)?.storedSamples).toBe(2 * BLOCK_SIZE + 1);
    expect(store.status().usedBytes).toBeGreaterThan(2 * BLOCK_BYTES);

    await settle();

    expect(store.status().usedBytes).toBeLessThanOrEqual(2 * BLOCK_BYTES);
  });

  test('brings back a block for a window narrower than a pyramid leaf', async () => {
    const { store } = cappedStore(3);
    const persistence = new MemoryBlockPersistence();
    store.startRecording(persistence);
    await streamBlocks(store, 0, 6);
    const window = [20_000, 28_000] as const;

    const approximate = store.decimate(1, ...window, 100);

    expect(Array.from(approximate.flags.subarray(0, 100)).filter(Boolean)).toHaveLength(1);

    await settle();
    const decimation = store.decimate(1, ...window, 100);

    expect(persistence.reads).toBe(1);
    expect(Array.from(decimation.flags.subarray(0, 100)).filter(Boolean)).toHaveLength(8);
  });

  test('does not read a block back when there is no room for it', async () => {
    const { store } = cappedStore(4);
    const persistence = new MemoryBlockPersistence();
    store.startRecording(persistence);
    await streamBlocks(store, 0, 6);
    store.stopRecording();
    await streamBlocks(store, 6, 12);

    const frames = async (left: number): Promise<void> => {
      if (left === 0) {
        return;
      }

      store.decimate(1, 0, 100_000, 1000);
      await settle();
      return frames(left - 1);
    };
    await frames(5);

    expect(store.status().historyStopped).toBe(true);
    expect(persistence.reads).toBe(0);
  });
});

describe('short epochs', () => {
  test('take little memory, because an epoch starts with a small block', () => {
    const store = new TelemetryStore({ scheduler: new ManualScheduler() });
    const variables = Array.from({ length: 16 }, (_, id) => ({ id, type: TypeCode.F32 }));
    const row = Array.from({ length: 16 }, () => 1);

    for (let epoch = 0; epoch < 50; epoch++) {
      store.openEpoch({ epochId: epoch, groupId: 0, variables });

      for (let index = 0; index < 100; index++) {
        store.append(epoch, index, (epoch * 100 + index) * 1000, row);
      }
    }

    const small = Block.byteLengthFor({ capacity: 1024, kinds: variables.map(() => 'f32') });

    expect(store.status().usedBytes).toBe(50 * small);
    expect(store.variable(0)?.storedSamples).toBe(5000);
  });
});
