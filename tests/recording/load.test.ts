import { describe, expect, test } from 'vitest';

import { ManualScheduler } from '@/history';
import type { BlockData, RecordedGap } from '@/history';
import { loadRecording, type StoredRecording } from '@/recording/load';
import { MemoryBlockBacking } from '@tests/support/history/memory-backing';

const MS = 1000;

function block(index: number, from: number, length: number): BlockData {
  const time = Float64Array.from({ length }, (_, sample) => (from + sample) * MS);
  return {
    ref: { runId: 1, index },
    startSample: from,
    time,
    columns: [{ variableId: 0, values: Float32Array.from(time, (timeUs) => timeUs / MS) }],
  };
}

function gap(startUs: number, index: number, count: number): RecordedGap {
  return {
    runId: 1,
    kind: 'not-stored',
    index,
    count,
    startUs,
    afterUs: Number.NaN,
    untilUs: index * MS,
  };
}

function recording(gaps: readonly RecordedGap[]): StoredRecording {
  return {
    schema: [{ id: 0, name: 'speed', type: 'f32' }],
    runs: [
      {
        run: { runId: 1, slot: 0, variables: [{ id: 0, name: 'speed', type: 'f32' }] },
        gaps,
        blocks: [block(1, 300, 100)],
      },
    ],
    boundaries: [
      { kind: 'reboot', timeUs: 450 * MS },
      { kind: 'reconnect', timeUs: 420 * MS },
    ],
    values: [{ variableId: 0, name: 'speed', timeUs: Number.NaN, value: 9 }],
  };
}

describe('loading a recording', () => {
  test('keeps the last gap written with a start, as a recorder writes a gap again as it grows', () => {
    const { store, skipped } = loadRecording(
      recording([gap(0, 100, 100), gap(0, 300, 300)]),
      new MemoryBlockBacking(),
      { scheduler: new ManualScheduler() }
    );

    expect(skipped).toBe(0);
    expect(store.gaps('speed', 0, 400 * MS)).toEqual([
      { kind: 'not-stored', startUs: 0, endUs: 300 * MS, count: 300 },
    ]);
    expect(store.variable('speed')).toMatchObject({ storedSamples: 100, runs: 1 });
  });

  test('closes every run, orders the boundaries and keeps the last sample as the latest value', () => {
    const { store } = loadRecording(recording([]), new MemoryBlockBacking(), {
      scheduler: new ManualScheduler(),
    });

    expect(store.boundaries().map(({ kind }) => kind)).toEqual(['reconnect', 'reboot']);
    expect(store.latest('speed')).toEqual({ value: 399, timeUs: 399 * MS });
    expect(() => store.append(1, 500 * MS, [1])).toThrow('closed');
  });
});
