/**
 * A sample as a test remembers it, independently of the store.
 */
export interface ReferenceSample {
  readonly timeUs: number;
  readonly value: number;
}

/**
 * What a brute-force decimation of a window finds in each pixel column.
 */
export interface ReferenceColumns {
  readonly data: boolean[];
  readonly nan: boolean[];
  readonly min: number[];
  readonly max: number[];
}

/**
 * The column a time falls in, computed the way the store documents it.
 */
export function referenceColumn(
  timeUs: number,
  startUs: number,
  endUs: number,
  pixels: number
): number {
  return Math.min(pixels - 1, Math.floor((timeUs - startUs) * (pixels / (endUs - startUs))));
}

/**
 * Decimate by looking at every sample.
 *
 * A column holding a NaN is drawn as a break, so its bounds do not matter; they are left out, as
 * {@link withoutNanBounds} does for the store's answer.
 */
export function referenceDecimation(
  samples: readonly ReferenceSample[],
  startUs: number,
  endUs: number,
  pixels: number
): ReferenceColumns {
  const columns: ReferenceColumns = {
    data: Array.from({ length: pixels }, () => false),
    nan: Array.from({ length: pixels }, () => false),
    min: Array.from({ length: pixels }, () => Number.POSITIVE_INFINITY),
    max: Array.from({ length: pixels }, () => Number.NEGATIVE_INFINITY),
  };

  for (const { timeUs, value } of samples) {
    if (timeUs < startUs || timeUs >= endUs) {
      continue;
    }

    const column = referenceColumn(timeUs, startUs, endUs, pixels);

    if (Number.isNaN(value)) {
      columns.nan[column] = true;
    } else {
      columns.data[column] = true;
      columns.min[column] = Math.min(columns.min[column], value);
      columns.max[column] = Math.max(columns.max[column], value);
    }
  }

  return withoutNanBounds(columns);
}

/**
 * Forget the bounds of the columns that hold a NaN.
 */
export function withoutNanBounds(columns: ReferenceColumns): ReferenceColumns {
  return {
    nan: columns.nan,
    data: columns.data.map((data, column) => data && !columns.nan[column]),
    min: columns.min.map((min, column) => (columns.nan[column] ? Number.POSITIVE_INFINITY : min)),
    max: columns.max.map((max, column) => (columns.nan[column] ? Number.NEGATIVE_INFINITY : max)),
  };
}

/**
 * A deterministic pseudo-random generator, so that failures reproduce.
 */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;

  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}
