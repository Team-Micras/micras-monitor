import { describe, expect, test } from 'vitest';

import { TypeCode } from '@/protocol';

import { COLUMN_HAS_DATA, COLUMN_HAS_NAN, Decimation, type DecimationStats } from './decimation';
import {
  referenceDecimation,
  type ReferenceColumns,
  type ReferenceSample,
  seededRandom,
  withoutNanBounds,
} from './fixtures/reference';
import { FANOUT, LEAF_SIZE } from './pyramid';
import { ManualScheduler } from './scheduler';
import { toBandSeries, toLineSeries } from './series';
import { TelemetryStore } from './store';

const MS = 1000;

interface Fixture {
  readonly store: TelemetryStore;
  readonly samples: ReferenceSample[];
}

function spikySignal(count: number, blockSize: number, seed: number): Fixture {
  const store = new TelemetryStore({ scheduler: new ManualScheduler(), blockSize });
  const random = seededRandom(seed);
  const samples: ReferenceSample[] = [];
  store.openEpoch({ epochId: 1, groupId: 0, variables: [{ id: 1, type: TypeCode.F32 }] });

  for (let index = 0; index < count; index++) {
    const timeUs = index * MS + Math.floor(random() * 500);
    let value = Math.sin(index / 300) + 0.1 * (random() - 0.5);

    if (index % 7919 === 1234) {
      value = random() < 0.5 ? 1e6 : -1e6;
    }

    if (index % 10_007 === 5000) {
      value = Number.NaN;
    }

    store.append(1, index & 0xffff, timeUs, [value]);
    samples.push({ timeUs, value: Math.fround(value) });
  }

  return { store, samples };
}

function columnsOf(decimation: Decimation): ReferenceColumns {
  const { pixels, flags } = decimation;
  const has = (flag: number) =>
    Array.from(flags.subarray(0, pixels), (state) => (state & flag) !== 0);
  const data = has(COLUMN_HAS_DATA);

  return withoutNanBounds({
    data,
    nan: has(COLUMN_HAS_NAN),
    min: Array.from(decimation.min.subarray(0, pixels), (value, column) =>
      data[column] ? value : Number.POSITIVE_INFINITY
    ),
    max: Array.from(decimation.max.subarray(0, pixels), (value, column) =>
      data[column] ? value : Number.NEGATIVE_INFINITY
    ),
  });
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
    const spikes = fixture.samples.filter(({ value }) => Math.abs(value) === 1e6).length;
    const shown = Array.from(decimation.max.subarray(0, 50)).filter((max) => max === 1e6).length;
    const shownLow = Array.from(decimation.min.subarray(0, 50)).filter((min) => min === -1e6);

    expect(spikes).toBeGreaterThan(4);
    expect(shown + shownLow.length).toBeGreaterThan(0);
    expect(Math.max(...decimation.max.subarray(0, 50))).toBe(
      Math.max(...fixture.samples.map(({ value }) => (Number.isNaN(value) ? 0 : value)))
    );
    expect(Math.min(...decimation.min.subarray(0, 50))).toBe(
      Math.min(...fixture.samples.map(({ value }) => (Number.isNaN(value) ? 0 : value)))
    );
  });

  test('turns NaN into null in the line and in the band', () => {
    const nanTime = fixture.samples[5000].timeUs;
    const decimation = fixture.store.decimate(1, nanTime - 50 * MS, nanTime + 50 * MS, 200);
    const column = decimation.columnOf(nanTime);
    const line = toLineSeries(decimation);
    const band = toBandSeries(decimation);

    expect(decimation.flags[column] & COLUMN_HAS_NAN).toBe(COLUMN_HAS_NAN);
    expect(line.y.slice(3 * column, 3 * column + 3)).toEqual([null, null, null]);
    expect(band.min[2 * column]).toBeNull();
    expect(band.max[2 * column]).toBeNull();
    expect(line.y.filter((value) => value === null)).toHaveLength(3);
    expect(line.y.filter((value) => typeof value === 'number').length).toBeGreaterThan(100);
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
    const into = new Decimation();
    const first = fixture.store.decimate(1, 0, last, 300, { into });
    const minBefore = into.min;
    const second = fixture.store.decimate(1, last / 2, last, 200, { into });
    const line = toLineSeries(second);
    const reused = toLineSeries(first, line);

    expect(first).toBe(into);
    expect(second).toBe(into);
    expect(into.min).toBe(minBefore);
    expect(reused).toBe(line);
    expect(reused.x).toHaveLength(600);
  });

  test('refuses an empty window', () => {
    expect(() => fixture.store.decimate(1, 5, 5, 10)).toThrow(RangeError);
    expect(() => fixture.store.decimate(1, 0, 5, 0)).toThrow(RangeError);
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
      const pieces = pixels + Math.ceil(fixture.samples.length / blockSize);

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
