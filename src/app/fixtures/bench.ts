/**
 * What a performance test measured, handed to `bun run bench` (`tools/bench.ts`) through the
 * test's meta, which compares its timings with a stored baseline.
 *
 * @module
 */

import type { TestContext } from 'vitest';

/** What one performance test measured. */
export interface BenchResult {
  /** Timings in milliseconds, lower being better, that the bench compares with its baseline. */
  readonly timings: Readonly<Record<string, number>>;
  /** What was measured, in one line, for the reader. */
  readonly summary: string;
}

declare module 'vitest' {
  interface TaskMeta {
    bench?: BenchResult;
  }
}

/** Hands what a performance test measured to the bench, and shows its summary with the test. */
export async function reportBench(context: TestContext, result: BenchResult): Promise<void> {
  context.task.meta.bench = result;
  await context.annotate(result.summary);
}

/** The value below which a share, from 0 to 1, of the values fall. */
export function percentile(values: readonly number[], share: number): number {
  const sorted = values.toSorted((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(share * sorted.length))] ?? Number.NaN;
}
