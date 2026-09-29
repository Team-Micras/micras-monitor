import { describe, expect, test } from 'vitest';

import { TypeCode } from '@/protocol';

import { Block } from './block';
import { COLUMN_HAS_DATA } from './decimation';
import type { RecordingFile } from './recording-file';
import { MemoryRecordingFile } from './recording-file';
import {
  RECORDING_FORMAT,
  RECORDING_FORMAT_VERSION,
  serializeRecording,
  type RecordingHeader,
} from './recording';
import { SavedRecording } from './recording-reader';
import { RecordingBlocks, SessionRecorder } from './recorder';
import { ManualScheduler } from './scheduler';
import { TelemetryStore, type TelemetryStoreOptions } from './store';
import type { SampleValue } from './types';

const BLOCK_SIZE = 1024;
const VARIABLES = [
  { id: 1, type: TypeCode.F32 },
  { id: 2, type: TypeCode.U32 },
];
const SCHEMA = [
  { id: 1, name: 'pose/x', type: TypeCode.F32 },
  { id: 2, name: 'localizer/accepted', type: TypeCode.U32 },
  { id: 3, name: 'maze', type: TypeCode.BLOB },
];
const HEADER: RecordingHeader = {
  format: RECORDING_FORMAT,
  version: RECORDING_FORMAT_VERSION,
  startedAtMs: 1_790_000_000_000,
  robot: { name: 'micras' },
  schema: SCHEMA,
  name: 'bench run',
};
const SAMPLE_US = 1000;

function settle(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

async function each(count: number, step: (index: number) => Promise<void>, from = 0) {
  if (from < count) {
    await step(from);
    await each(count, step, from + 1);
  }
}

function makeStore(options: Partial<TelemetryStoreOptions> = {}) {
  let nowMs = 0;
  const scheduler = new ManualScheduler();
  const store = new TelemetryStore({
    scheduler,
    blockSize: BLOCK_SIZE,
    now: () => nowMs,
    ...options,
  });
  store.setSchema(SCHEMA);
  return {
    store,
    scheduler,
    advance: (ms: number) => {
      nowMs += ms;
    },
  };
}

function valueAt(index: number): number {
  return Math.fround(Math.sin(index / 37) * 3);
}

function appendRange(store: TelemetryStore, epochId: number, from: number, to: number): void {
  for (let index = from; index < to; index++) {
    store.append(epochId, index & 0xffff, index * SAMPLE_US, [valueAt(index), index]);
  }
}

function everySample(store: TelemetryStore, name: string): SampleValue[] {
  const samples: SampleValue[] = [];

  for (const run of store.samples(name, Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY)) {
    for (let index = 0; index < run.time.length; index++) {
      samples.push({ timeUs: run.time[index], value: run.values[index] });
    }
  }

  return samples;
}

async function reopen(file: RecordingFile, options: Partial<TelemetryStoreOptions> = {}) {
  const saved = await SavedRecording.read(file);
  const { store, scheduler } = makeStore(options);
  const skipped = saved.loadInto(store);
  return { saved, store, scheduler, skipped };
}

class FlakyFile extends MemoryRecordingFile {
  failures = 0;

  override write(offset: number, bytes: Uint8Array): Promise<void> {
    if (this.failures > 0) {
      this.failures--;
      void super.write(offset, bytes.subarray(0, Math.floor(bytes.byteLength / 2)));
      return Promise.reject(new Error('QuotaExceededError'));
    }

    return super.write(offset, bytes);
  }
}

function orderedBlock(index: number) {
  return {
    ref: { epochId: 1, index },
    startSample: index * 2,
    time: new Float64Array([index * 2 * SAMPLE_US, (index * 2 + 1) * SAMPLE_US]),
    columns: [
      { variableId: 1, values: new Float32Array([1, 2]) },
      { variableId: 2, values: new Float64Array([3, 4]) },
    ],
  };
}

function orderedSession(indices: readonly number[]) {
  return {
    schema: SCHEMA,
    epochs: [
      {
        epoch: { epochId: 1, groupId: 0, variables: SCHEMA.slice(0, 2) },
        gaps: [],
        blocks: indices.map(orderedBlock),
      },
    ],
    boundaries: [],
    values: [],
  };
}

describe('recording a session', () => {
  test('writes the header, the session so far and what comes after, and reads back the same', async () => {
    const { store, advance } = makeStore();
    store.openEpoch({ epochId: 1, groupId: 0, variables: VARIABLES, firstSequence: 0 });
    appendRange(store, 1, 0, 1500);
    const file = new MemoryRecordingFile();
    const recorder = await SessionRecorder.start(file, HEADER, store);
    appendRange(store, 1, 1500, 1600);
    store.append(1, 1610, 1610 * SAMPLE_US, [valueAt(1610), 1610]);
    advance(5000);
    appendRange(store, 1, 1611, 2000);
    store.setLatestValue(3, new Uint8Array([1, 2, 3]), 1_999_000);
    store.markBoundary('reconnect', 2_000_500);
    await recorder.stop(store);

    const { saved, store: reopened } = await reopen(file);

    expect(saved.summary.header.name).toBe('bench run');
    expect(saved.summary.damaged).toEqual([]);
    expect(saved.summary.truncatedAt).toBeUndefined();
    expect(saved.summary.samples).toBe(1990);
    expect(recorder.status.samples).toBe(1990);
    expect(recorder.status.bytes).toBe(file.contents().byteLength);
    expect(everySample(reopened, 'pose/x')).toEqual(everySample(store, 'pose/x'));
    expect(everySample(reopened, 'localizer/accepted')).toEqual(
      everySample(store, 'localizer/accepted')
    );
    expect(reopened.gaps('pose/x', 0, 3e6)).toEqual(store.gaps('pose/x', 0, 3e6));
    expect(reopened.boundaries()).toEqual(store.boundaries());
    expect(reopened.variable('pose/x')).toMatchObject({ storedSamples: 1990, droppedSamples: 10 });
    expect(reopened.latest('pose/x')).toEqual({ value: valueAt(1999), timeUs: 1_999_000 });
    expect(reopened.history('maze').map((entry) => entry.value)).toEqual([
      new Uint8Array([1, 2, 3]),
    ]);
    expect(reopened.timeRange()).toEqual(store.timeRange());
  });

  test('seals and writes the open block every flush interval, so a killed tab loses at most that', async () => {
    const { store, advance } = makeStore();
    store.openEpoch({ epochId: 1, groupId: 0, variables: VARIABLES, firstSequence: 0 });
    const file = new MemoryRecordingFile();
    const recorder = await SessionRecorder.start(file, HEADER, store);

    await each(23, async (second) => {
      appendRange(store, 1, second * 100, (second + 1) * 100);
      advance(1000);
      await settle();
    });

    await recorder.flush();
    const killed = new MemoryRecordingFile(file.contents());
    const { store: reopened } = await reopen(killed);
    const recovered = reopened.timeRange('pose/x');

    expect(recovered?.startUs).toBe(0);
    expect(store.timeRange('pose/x')!.endUs - recovered!.endUs).toBeLessThanOrEqual(5 * 100_000);
    expect(everySample(reopened, 'pose/x')).toEqual(
      everySample(store, 'pose/x').filter((sample) => sample.timeUs < recovered!.endUs)
    );
  });

  test('keeps the whole records of a file cut in the middle of a write and reports the tail', async () => {
    const { store, advance } = makeStore();
    store.openEpoch({ epochId: 1, groupId: 0, variables: VARIABLES, firstSequence: 0 });
    const file = new MemoryRecordingFile();
    const recorder = await SessionRecorder.start(file, HEADER, store);
    appendRange(store, 1, 0, 500);
    advance(5000);
    appendRange(store, 1, 500, 501);
    await recorder.flush();
    const whole = file.contents().byteLength;
    advance(5000);
    appendRange(store, 1, 501, 900);
    await recorder.flush();
    const cut = new MemoryRecordingFile(file.contents().slice(0, whole + 40));

    const { saved, store: reopened } = await reopen(cut);

    expect(saved.summary.truncatedAt).toBe(whole);
    expect(saved.summary.validEnd).toBe(whole);
    expect(reopened.variable('pose/x')?.storedSamples).toBe(501);
  });

  test('skips and reports a damaged record in the middle, and keeps the records after it', async () => {
    const { store, advance } = makeStore();
    store.openEpoch({ epochId: 1, groupId: 0, variables: VARIABLES, firstSequence: 0 });
    const file = new MemoryRecordingFile();
    const recorder = await SessionRecorder.start(file, HEADER, store);
    const marks: number[] = [];

    await each(3, async (part) => {
      appendRange(store, 1, part * 300, (part + 1) * 300);
      advance(5000);
      appendRange(store, 1, (part + 1) * 300, (part + 1) * 300 + 1);
      await recorder.flush();
      marks.push(file.contents().byteLength);
    });

    await recorder.stop(store);
    const bytes = file.contents();
    bytes[marks[0] + 40] ^= 0xff;

    const { saved, store: reopened } = await reopen(new MemoryRecordingFile(bytes));

    expect(saved.summary.damaged).toEqual([{ offset: marks[0], reason: 'check mismatch' }]);
    expect(saved.summary.truncatedAt).toBeUndefined();
    expect(reopened.variable('pose/x')?.storedSamples).toBe(
      store.variable('pose/x')!.storedSamples - 300
    );
  });

  test('writes back blocks that left memory from the file they left for, in their place', async () => {
    const blockBytes = Block.byteLengthFor({ capacity: BLOCK_SIZE, kinds: ['f32', 'f64'] });
    const { store } = makeStore({ memoryCapBytes: 3 * blockBytes });
    store.openEpoch({ epochId: 1, groupId: 0, variables: VARIABLES, firstSequence: 0 });
    const first = new MemoryRecordingFile();
    const recorder = await SessionRecorder.start(first, HEADER, store);

    await each(6, async (block) => {
      appendRange(store, 1, block * BLOCK_SIZE, (block + 1) * BLOCK_SIZE);
      await settle();
    });

    await recorder.stop(store);
    expect(store.status().evictedBlocks).toBeGreaterThan(0);
    const second = new MemoryRecordingFile();
    const again = await SessionRecorder.start(second, HEADER, store);
    await settle();
    await settle();
    await again.stop(store);

    const { store: reopened } = await reopen(second);

    const samples = everySample(reopened, 'pose/x');

    expect(reopened.variable('pose/x')?.storedSamples).toBe(6 * BLOCK_SIZE);
    expect(samples).toHaveLength(6 * BLOCK_SIZE);
    expect(samples.every((sample, index) => sample.timeUs === index * SAMPLE_US)).toBe(true);
    expect(samples.every((sample, index) => sample.value === valueAt(index))).toBe(true);
  });

  test('gives a later gap record with the start of an earlier one precedence over it', async () => {
    const gap = {
      epochId: 1,
      kind: 'not-stored' as const,
      index: 1024,
      count: 512,
      startUs: 0,
      afterUs: Number.NaN,
      untilUs: 512 * SAMPLE_US,
    };
    const bytes = serializeRecording({
      header: HEADER,
      records: [
        { kind: 'epoch', epoch: { epochId: 1, groupId: 0, variables: SCHEMA.slice(0, 2) } },
        { kind: 'gap', gap },
        {
          kind: 'block',
          block: {
            ref: { epochId: 1, index: 2 },
            startSample: 1024,
            time: new Float64Array([1024 * SAMPLE_US, 1025 * SAMPLE_US]),
            columns: [
              { variableId: 1, values: new Float32Array([1, 2]) },
              { variableId: 2, values: new Float64Array([3, 4]) },
            ],
          },
        },
        { kind: 'gap', gap: { ...gap, count: 1024, untilUs: 1024 * SAMPLE_US } },
        { kind: 'epoch-closed', epochId: 1 },
      ],
    });

    const { store: reopened } = await reopen(new MemoryRecordingFile(bytes));

    expect(reopened.gaps('pose/x', 0, 1e12)).toEqual([
      { kind: 'not-stored', startUs: 0, endUs: 1024 * SAMPLE_US, count: 1024 },
    ]);
    expect(reopened.variable('pose/x')).toMatchObject({ storedSamples: 2, droppedSamples: 0 });
  });

  test('reports a failed write, writes its events again and lets the store retry its blocks', async () => {
    const { store, advance } = makeStore();
    store.openEpoch({ epochId: 1, groupId: 0, variables: VARIABLES, firstSequence: 0 });
    const file = new FlakyFile();
    const errors: unknown[] = [];
    const recorder = await SessionRecorder.start(file, HEADER, store, (error) =>
      errors.push(error)
    );
    file.failures = 1;
    appendRange(store, 1, 0, 400);
    advance(5000);
    appendRange(store, 1, 400, 401);
    await settle();
    await recorder.flush();

    expect(errors).toHaveLength(1);
    expect(recorder.status.failing).toBe(true);
    expect(store.status().persistenceFailing).toBe(true);

    advance(5000);
    appendRange(store, 1, 401, 402);
    await settle();
    await recorder.stop(store);

    expect(recorder.status.failing).toBe(false);
    const { saved, store: reopened } = await reopen(file);
    expect(saved.summary.damaged).toEqual([]);
    expect(saved.summary.truncatedAt).toBeUndefined();
    expect(everySample(reopened, 'pose/x')).toEqual(everySample(store, 'pose/x'));
  });
});

describe('a saved session under the memory cap', () => {
  test('leaves memory as it loads and comes back from the file when a query needs it', async () => {
    const { store, advance } = makeStore();
    store.openEpoch({ epochId: 1, groupId: 0, variables: VARIABLES, firstSequence: 0 });
    const file = new MemoryRecordingFile();
    const recorder = await SessionRecorder.start(file, HEADER, store);

    for (let block = 0; block < 8; block++) {
      appendRange(store, 1, block * BLOCK_SIZE, (block + 1) * BLOCK_SIZE);
      advance(1000);
    }

    await recorder.stop(store);
    const blockBytes = Block.byteLengthFor({ capacity: BLOCK_SIZE, kinds: ['f32', 'f64'] });
    const {
      store: reopened,
      scheduler,
      skipped,
    } = await reopen(file, {
      memoryCapBytes: 3 * blockBytes,
    });

    expect(skipped).toBe(0);
    expect(reopened.status().evictedBlocks).toBeGreaterThan(0);
    expect(reopened.status().usedBytes).toBeLessThanOrEqual(3 * blockBytes);
    const whole = reopened.decimate('pose/x', 0, 8 * BLOCK_SIZE * SAMPLE_US, 64);
    expect([...whole.flags.subarray(0, 64)].every((flags) => (flags & COLUMN_HAS_DATA) !== 0)).toBe(
      true
    );

    scheduler.flush();
    const early = { startUs: 100 * SAMPLE_US, endUs: 400 * SAMPLE_US };
    expect(reopened.valueAt('pose/x', 200 * SAMPLE_US)).toBeUndefined();
    scheduler.flush();
    await settle();
    expect(reopened.valueAt('pose/x', 200 * SAMPLE_US)).toEqual({
      value: valueAt(200),
      timeUs: 200 * SAMPLE_US,
    });
    expect([...reopened.samples('pose/x', early.startUs, early.endUs)][0].time.length).toBe(300);
  });

  test('takes the blocks of an epoch in index order only, appending each one', async () => {
    const source = new MemoryRecordingFile();

    expect(makeStore().store.load(orderedSession([0, 1, 2]), new RecordingBlocks(source))).toBe(0);
    expect(() =>
      makeStore().store.load(orderedSession([0, 2, 1]), new RecordingBlocks(source))
    ).toThrow(/Block 1 of epoch 1 comes after block 2/);
  });

  test('refuses to load into a store that already holds a session', async () => {
    const { store } = makeStore();
    store.openEpoch({ epochId: 1, groupId: 0, variables: VARIABLES, firstSequence: 0 });
    const file = new MemoryRecordingFile();
    const recorder = await SessionRecorder.start(file, HEADER, store);
    await recorder.stop(store);
    const saved = await SavedRecording.read(file);

    expect(() => saved.loadInto(store)).toThrow(/empty store/);
  });
});
