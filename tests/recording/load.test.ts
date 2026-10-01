import { describe, expect, test } from 'vitest';

import { Block } from '@/history/block';
import { HistoryStore, ManualScheduler } from '@/history';
import type { BlockData, RecordedGap } from '@/history';
import { loadRecording, type StoredRecording } from '@/recording/load';
import { MemoryBlockBacking } from '@tests/support/history/memory-backing';
import { storedSamples } from '@tests/support/history/sample-counts';

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

function live(readBetween: boolean): HistoryStore {
  const store = new HistoryStore({ scheduler: new ManualScheduler() });
  store.setSchema([{ id: 0, name: 'speed', type: 'f32' }]);
  store.openRun({ runId: 1, slot: 0, variables: [{ id: 0, type: 'f32' }] });

  for (let sample = 300; sample < 400; sample++) {
    store.append(1, sample * MS, [sample]);
  }

  if (readBetween) {
    store.status();
  }

  store.closeRun(1);
  return store;
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
    expect(storedSamples(store, 'speed')).toBe(100);
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

describe('the bytes a store reports', () => {
  test('are those of its blocks once compacted, read or not before, live or loaded', () => {
    const open = new HistoryStore({ scheduler: new ManualScheduler() });
    open.openRun({ runId: 1, slot: 0, variables: [{ id: 0, type: 'f32' }] });
    open.append(1, 0, [1]);
    const { store: loaded } = loadRecording(recording([]), new MemoryBlockBacking(), {
      scheduler: new ManualScheduler(),
    });

    expect(live(false).status().usedBytes).toBe(live(true).status().usedBytes);
    expect(live(false).status().usedBytes).toBeLessThan(open.status().usedBytes);
    expect(loaded.status().usedBytes).toBeLessThan(
      Block.byteLengthFor({ capacity: 128, kinds: ['f32'] })
    );
  });
});
