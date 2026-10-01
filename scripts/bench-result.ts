/**
 * What the performance tests hand `bun run bench`, and what the bench stores and compares. The
 * tests set a {@link BenchResult} on their meta (`tests/support/app/bench.ts`); the bench keeps
 * their timings as a {@link BenchRecord}, the stored baseline or the results of one run.
 *
 * @module
 */

/** What one performance test measured. */
export interface BenchResult {
  /** Timings in milliseconds, lower being better, that the bench compares with a baseline. */
  readonly timings: Readonly<Record<string, number>>;
  /** The most, in milliseconds, some of the timings may take on any machine. */
  readonly budgets?: Readonly<Record<string, number>>;
  /** What was measured, in one line, for the reader. */
  readonly summary: string;
}

/** The timings of each performance test, by its full name. */
export type BenchTimings = Readonly<Record<string, Readonly<Record<string, number>>>>;

/** Timings of one run, with when and where they were measured. */
export interface BenchRecord {
  readonly recorded: string;
  readonly machine: string;
  readonly tests: BenchTimings;
}
