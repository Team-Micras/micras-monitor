import { describe, expect, test } from 'vitest';

import { seededRandom } from './fixtures/reference';
import { FANOUT, LEAF_SIZE, MinMaxAccumulator, MinMaxPyramid } from './pyramid';

function filled(values: readonly number[], capacity: number): MinMaxPyramid {
  const pyramid = new MinMaxPyramid('f64', capacity);

  for (const value of values) {
    pyramid.push(value);
  }

  return pyramid;
}

function bruteForce(values: readonly number[], start: number, end: number) {
  const slice = values.slice(start, end);
  const numbers = slice.filter((value) => !Number.isNaN(value));

  return {
    nan: numbers.length !== slice.length,
    min: numbers.reduce((min, value) => Math.min(min, value), Number.POSITIVE_INFINITY),
    max: numbers.reduce((max, value) => Math.max(max, value), Number.NEGATIVE_INFINITY),
  };
}

function boundsOf(accumulator: MinMaxAccumulator) {
  return { nan: accumulator.nan, min: accumulator.min, max: accumulator.max };
}

function signal(length: number, seed: number): number[] {
  const random = seededRandom(seed);
  return Array.from({ length }, (_, index) => Math.sin(index / 50) + random() - 0.5);
}

describe('MinMaxPyramid', () => {
  test('has one level per factor of four between a leaf and the whole block', () => {
    expect(new MinMaxPyramid('f32', 65_536).levels).toBe(7);
    expect(new MinMaxPyramid('f32', 1024).levels).toBe(4);
    expect(new MinMaxPyramid('f32', 2048).levels).toBe(5);
    expect(new MinMaxPyramid('f32', LEAF_SIZE).levels).toBe(1);
  });

  test('knows its size before it is made', () => {
    for (const capacity of [16, 64, 128, 1024, 65_536]) {
      expect(MinMaxPyramid.byteLengthFor('f32', capacity)).toBe(
        new MinMaxPyramid('f32', capacity).byteLength
      );
      expect(MinMaxPyramid.byteLengthFor('f64', capacity)).toBe(
        new MinMaxPyramid('f64', capacity).byteLength
      );
    }
  });

  test('gives the exact bounds of any range while it fills', () => {
    const values = signal(1000, 1);
    const pyramid = filled(values, 1024);
    const random = seededRandom(2);

    for (let trial = 0; trial < 500; trial++) {
      const start = Math.floor(random() * values.length);
      const end = start + 1 + Math.floor(random() * (values.length - start));
      const bounds = new MinMaxAccumulator();
      pyramid.addSamples(Float64Array.from(values), start, end, bounds);

      expect(boundsOf(bounds)).toEqual(bruteForce(values, start, end));
    }
  });

  test('keeps the bounds of the numbers around a NaN and marks the NaN apart', () => {
    const values = signal(1024, 3);
    values[517] = Number.NaN;
    values[3] = Number.NaN;
    const pyramid = filled(values, 1024);
    const raw = Float64Array.from(values);

    for (const [start, end] of [
      [0, 1024],
      [500, 600],
      [517, 518],
      [0, 517],
      [518, 1024],
      [16, 1008],
    ]) {
      const bounds = new MinMaxAccumulator();
      pyramid.addSamples(raw, start, end, bounds);

      expect(boundsOf(bounds)).toEqual(bruteForce(values, start, end));
    }
  });

  test('answers for whole leaves from the pyramid alone once sealed', () => {
    const values = signal(700, 4);
    values[100] = 50;
    values[650] = -50;
    values[333] = Number.NaN;
    const pyramid = filled(values, 1024);
    pyramid.seal();
    const leaves = Math.ceil(values.length / LEAF_SIZE);

    for (let first = 0; first < leaves; first += 3) {
      for (let end = first + 1; end <= leaves; end += 5) {
        const bounds = new MinMaxAccumulator();
        pyramid.addLeaves(first, end, bounds);

        expect(boundsOf(bounds)).toEqual(bruteForce(values, first * LEAF_SIZE, end * LEAF_SIZE));
        expect(bounds.rawSamples).toBe(0);
      }
    }
  });

  test('shrinks to the samples it holds once sealed and compacted, with the same answers', () => {
    const values = signal(750, 6);
    const pyramid = filled(values, 65_536);
    pyramid.seal();
    const before = pyramid.byteLength;
    pyramid.compact();
    const bounds = new MinMaxAccumulator();
    pyramid.addLeaves(0, Math.ceil(750 / LEAF_SIZE), bounds);

    expect(pyramid.byteLength).toBeLessThan(before / 50);
    expect(boundsOf(bounds)).toEqual(bruteForce(values, 0, 750));
  });

  test('reads at most a few entries per level, however long the range', () => {
    const values = signal(65_536, 5);
    const pyramid = filled(values, 65_536);
    const raw = Float64Array.from(values);
    const perLevel = 2 * (FANOUT - 1);

    for (const [start, end] of [
      [0, 65_536],
      [7, 65_531],
      [1000, 50_000],
      [33, 97],
    ]) {
      const bounds = new MinMaxAccumulator();
      pyramid.addSamples(raw, start, end, bounds);

      expect(bounds.pyramidEntries).toBeLessThanOrEqual(perLevel * pyramid.levels);
      expect(bounds.rawSamples).toBeLessThan(2 * LEAF_SIZE);
      expect(boundsOf(bounds)).toEqual(bruteForce(values, start, end));
    }
  });
});
