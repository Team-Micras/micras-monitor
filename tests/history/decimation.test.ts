import { describe, expect, test } from 'vitest';

import {
  COLUMN_BREAKS,
  COLUMN_HAS_DATA,
  COLUMN_HAS_NAN,
  type Decimation,
  type DecimationStats,
} from '@/history/decimation';
import {
  referenceColumn,
  referenceDecimation,
  type ReferenceColumns,
  type ReferenceSample,
  seededRandom,
} from '@tests/support/history/reference';
import { FANOUT, LEAF_SIZE } from '@/history/min-max-pyramid';
import { toBandSeries, toLineSeries } from '@/history/series';
import { HistoryStore } from '@/history/history-store';
import { historyWindow, liveWindow } from '@/history/window';
import { ManualScheduler } from '@/history';

const MS = 1000;

interface Fixture {
  readonly store: HistoryStore;
  readonly samples: ReferenceSample[];
}

function newStore(blockSize: number): HistoryStore {
  const store = new HistoryStore({ scheduler: new ManualScheduler(), blockSize });
  store.openEpoch({ epochId: 1, groupId: 0, variables: [{ id: 1, type: 'f32' }] });
  return store;
}

function spikySignal(count: number, blockSize: number, seed: number): Fixture {
  const store = newStore(blockSize);
  const random = seededRandom(seed);
  const samples: ReferenceSample[] = [];

  for (let index = 0; index < count; index++) {
    const timeUs = index * MS + Math.floor(random() * 500);
    let value = Math.sin(index / 300) + 0.1 * (random() - 0.5);

    if (index % 7919 === 1234) {
      value = random() < 0.5 ? 1e6 : -1e6;
    }

    if (index % 10_007 === 5000) {
      value = Number.NaN;
    }

    store.append(1, timeUs, [value]);
    samples.push({ timeUs, value: Math.fround(value) });
  }

  return { store, samples };
}

function columnsOf(decimation: Decimation): ReferenceColumns {
  const { pixels, flags } = decimation;
  const has = (flag: number) =>
    Array.from(flags.subarray(0, pixels), (state) => (state & flag) !== 0);
  const data = has(COLUMN_HAS_DATA);

  return {
    data,
    nan: has(COLUMN_HAS_NAN),
    min: Array.from(decimation.min.subarray(0, pixels), (value, column) =>
      data[column] ? value : Number.POSITIVE_INFINITY
    ),
    max: Array.from(decimation.max.subarray(0, pixels), (value, column) =>
      data[column] ? value : Number.NEGATIVE_INFINITY
    ),
  };
}

function breaksOf(decimation: Decimation): number[] {
  return Array.from({ length: decimation.pixels }, (_, column) => column).filter(
    (column) => (decimation.flags[column] & COLUMN_BREAKS) !== 0
  );
}

describe('decimation', () => {
  const fixture = spikySignal(60_000, 4096, 11);
  const last = fixture.samples.at(-1)?.timeUs ?? 0;

  test('matches a brute-force min/max over the whole history', () => {
    for (const pixels of [1, 7, 100, 1600]) {
      const decimation = fixture.store.decimate(1, 0, last + 1, pixels);

      expect(columnsOf(decimation)).toEqual(
        referenceDecimation(fixture.samples, 0, last + 1, pixels)
      );
    }
  });

  test('matches it for random windows, dense and sparse alike', () => {
    const random = seededRandom(12);

    for (let trial = 0; trial < 200; trial++) {
      const startUs = Math.floor(random() * last);
      const endUs = startUs + 1 + Math.floor(random() * random() * (last - startUs));
      const pixels = 1 + Math.floor(random() * 800);
      const decimation = fixture.store.decimate(1, startUs, endUs, pixels);

      expect(columnsOf(decimation)).toEqual(
        referenceDecimation(fixture.samples, startUs, endUs, pixels)
      );
    }
  });

  test('keeps every spike, however far it is zoomed out', () => {
    const decimation = fixture.store.decimate(1, 0, last + 1, 50);
    const numbers = fixture.samples
      .map(({ value }) => value)
      .filter((value) => !Number.isNaN(value));

    expect(numbers.filter((value) => Math.abs(value) === 1e6).length).toBeGreaterThan(4);
    expect(Math.max(...decimation.max.subarray(0, 50))).toBe(Math.max(...numbers));
    expect(Math.min(...decimation.min.subarray(0, 50))).toBe(Math.min(...numbers));
  });

  test('draws the numbers around a NaN and breaks the line after its column', () => {
    const nanTime = fixture.samples[5000].timeUs;
    const decimation = fixture.store.decimate(1, nanTime - 50 * MS, nanTime + 50 * MS, 20);
    const column = decimation.columnOf(nanTime);
    const line = toLineSeries(decimation);
    const band = toBandSeries(decimation);

    expect(decimation.flags[column]).toBe(COLUMN_HAS_DATA | COLUMN_HAS_NAN);
    expect(line.y.slice(3 * column, 3 * column + 3)).toEqual([
      decimation.min[column],
      decimation.max[column],
      null,
    ]);
    expect(band.min.slice(2 * column, 2 * column + 2)).toEqual([decimation.min[column], null]);
    expect(line.y.filter((value) => value === null)).toHaveLength(1);
  });

  test('leaves a column all null only when it holds nothing but NaN', () => {
    const store = newStore(1024);

    for (let index = 0; index < 100; index++) {
      store.append(1, index * MS, [index >= 40 && index < 60 ? Number.NaN : index]);
    }

    const line = toLineSeries(store.decimate(1, 0, 100 * MS, 10));

    expect(line.y.slice(12, 18)).toEqual([null, null, null, null, null, null]);
    expect(line.y.slice(9, 12)).toEqual([30, 39, undefined]);
    expect(line.y.slice(18, 21)).toEqual([60, 69, undefined]);
  });

  test('still plots a signal with a NaN every 50 samples at 1,600 px', () => {
    const store = newStore(65_536);

    for (let index = 0; index < 200_000; index++) {
      store.append(1, index * MS, [index % 50 === 0 ? Number.NaN : Math.sin(index)]);
    }

    const decimation = store.decimate(1, 0, 200_000 * MS, 1600);
    const line = toLineSeries(decimation);
    const drawn = Array.from({ length: 1600 }, (_, column) => line.y[3 * column]);

    expect(drawn.every((value) => typeof value === 'number')).toBe(true);
    expect(Math.min(...decimation.min.subarray(0, 1600))).toBeLessThan(-0.99);
  });

  test('lays out a shared x axis whatever the series', () => {
    const decimation = fixture.store.decimate(1, 0, 1000, 4);
    const other = fixture.store.decimate(2, 0, 1000, 4);

    expect(toLineSeries(decimation).x).toEqual([
      62.5, 125, 187.5, 312.5, 375, 437.5, 562.5, 625, 687.5, 812.5, 875, 937.5,
    ]);
    expect(toLineSeries(other).x).toEqual(toLineSeries(decimation).x);
    expect(toLineSeries(other).y.every((value) => value === undefined)).toBe(true);
  });

  test('reuses the arrays it is given', () => {
    const first = fixture.store.decimate(1, 0, last, 300);
    const minBefore = first.min;
    const second = fixture.store.decimate(1, last / 2, last, 200, { into: first });
    const line = toLineSeries(second);
    const reused = toLineSeries(first, line);

    expect(second).toBe(first);
    expect(first.min).toBe(minBefore);
    expect(reused).toBe(line);
    expect(reused.x).toHaveLength(600);
  });

  test('clamps the column of a time outside the window', () => {
    const decimation = fixture.store.decimate(1, 1000, 2000, 10);

    expect(decimation.columnOf(0)).toBe(0);
    expect(decimation.columnOf(5000)).toBe(9);
  });

  test('refuses an empty window', () => {
    expect(() => fixture.store.decimate(1, 5, 5, 10)).toThrow(RangeError);
    expect(() => fixture.store.decimate(1, 0, 5, 0)).toThrow(RangeError);
  });
});

describe('breaks at gaps', () => {
  test('match a break per column whose last gap reaches past it, with many gaps', () => {
    const store = newStore(4096);
    const random = seededRandom(31);
    const gaps: { afterUs: number; untilUs: number }[] = [];
    let previous = Number.NaN;

    for (let index = 0, sequence = 0; index < 50_000; index++) {
      const skip = random() < 0.3 ? 1 + Math.floor(random() * 30) : 0;
      sequence += skip;
      const timeUs = (index + sequence) * MS;
      store.append(1, timeUs, [index], skip);

      if (skip > 0 && !Number.isNaN(previous)) {
        gaps.push({ afterUs: previous, untilUs: timeUs });
      }

      previous = timeUs;
      sequence++;
    }

    for (const pixels of [50, 700, 4000]) {
      const endUs = previous + 1;
      const expected = new Set<number>();

      for (const { afterUs, untilUs } of gaps) {
        const column = referenceColumn(afterUs, 0, endUs, pixels);

        if (referenceColumn(untilUs, 0, endUs, pixels) !== column) {
          expected.add(column);
        }
      }

      expect(breaksOf(store.decimate(1, 0, endUs, pixels))).toEqual(
        [...expected].toSorted((left, right) => left - right)
      );
    }
  });
});

describe('live decimation', () => {
  test('recomputes only the trailing columns and matches a full recompute', () => {
    const store = newStore(4096);
    const samples: ReferenceSample[] = [];
    const push = (from: number, to: number) => {
      for (let index = from; index < to; index++) {
        const value = index % 997 === 3 ? Number.NaN : Math.cos(index / 40);
        store.append(1, index * MS, [value]);
        samples.push({ timeUs: index * MS, value: Math.fround(value) });
      }
    };
    push(0, 30_000);
    const window = historyWindow({ startUs: 0, endUs: 30_000 * MS }, 800);
    const cached = store.decimate(1, window.startUs, window.endUs, 800);

    for (let frame = 0; frame < 20; frame++) {
      push(30_000 + 8 * frame, 30_008 + 8 * frame);
      const stats: DecimationStats = { rawSamples: 0, pyramidEntries: 0 };
      store.decimate(1, window.startUs, window.endUs, 800, { into: cached, stats });

      expect(stats.rawSamples + stats.pyramidEntries).toBeLessThan(200);
    }

    expect(columnsOf(cached)).toEqual(
      referenceDecimation(samples, window.startUs, window.endUs, 800)
    );
    expect(store.decimate(1, window.startUs, window.endUs, 800, { into: cached })).toBe(cached);
  });

  test('recomputes everything when the history changed further back', () => {
    const store = newStore(1024);

    for (let index = 0; index < 5000; index++) {
      store.append(1, index * MS, [1]);
    }

    const cached = store.decimate(1, 0, 8192 * MS, 64);
    store.markBoundary('reconnect', 100 * MS);
    store.decimate(1, 0, 8192 * MS, 64, { into: cached });

    expect(breaksOf(cached)).toEqual([0]);
  });

  test('windows keep their grid as time goes on', () => {
    const first = liveWindow(10_003_000, 10_000_000, 1000);
    const later = liveWindow(10_004_500, 10_000_000, 1000);
    const history = historyWindow({ startUs: 3000, endUs: 1_000_000 }, 1000);
    const grown = historyWindow({ startUs: 3000, endUs: 1_020_000 }, 1000);

    expect(first.endUs - first.startUs).toBe(10_000_000);
    expect(first.endUs).toBeGreaterThan(10_003_000);
    expect((later.startUs - first.startUs) % 10_000).toBe(0);
    expect(history).toEqual(grown);
    expect(history.startUs).toBeLessThanOrEqual(3000);
    expect(history.endUs).toBeGreaterThan(1_020_000);
  });
});

function costOf(fixture: Fixture, pixels: number): DecimationStats {
  const stats: DecimationStats = { rawSamples: 0, pyramidEntries: 0 };
  const last = fixture.samples.at(-1)?.timeUs ?? 0;
  fixture.store.decimate(1, 0, last + 1, pixels, { stats });
  return stats;
}

describe('decimation cost', () => {
  test('follows the pixels and pyramid levels, not the history', () => {
    const blockSize = 16_384;
    const levels = Math.log(blockSize / LEAF_SIZE) / Math.log(FANOUT) + 1;
    const small = spikySignal(200_000, blockSize, 21);
    const large = spikySignal(800_000, blockSize, 22);
    const pixels = 400;

    for (const fixture of [small, large]) {
      const stats = costOf(fixture, pixels);
      const pieces = pixels + Math.ceil(fixture.samples.length / 1024);

      expect(stats.rawSamples).toBeLessThanOrEqual(pieces * 2 * LEAF_SIZE);
      expect(stats.pyramidEntries).toBeLessThanOrEqual(pieces * 2 * (FANOUT - 1) * levels);
    }

    const growth = costOf(large, pixels).pyramidEntries / costOf(small, pixels).pyramidEntries;

    expect(growth).toBeLessThan(1.5);
    expect(costOf(large, pixels).rawSamples + costOf(large, pixels).pyramidEntries).toBeLessThan(
      large.samples.length / 20
    );
  });

  test('reads the raw samples of a sparse window directly', () => {
    const fixture = spikySignal(20_000, 4096, 23);
    const stats: DecimationStats = { rawSamples: 0, pyramidEntries: 0 };
    fixture.store.decimate(1, 10_000 * MS, 12_000 * MS, 1600, { stats });

    expect(stats.pyramidEntries).toBe(0);
    expect(stats.rawSamples).toBe(2000);
  });
});
