/**
 * What a performance test measured, handed to `bun run bench` (`scripts/bench.ts`) through the
 * test's meta, which judges its timings against their budgets and a baseline.
 *
 * @module
 */

import type { TestContext } from 'vitest';

import type { BenchResult } from '@scripts/bench-result';

export type { BenchResult };

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
