/**
 * How `bun run bench` judges what the performance tests measured: against the absolute budgets
 * the tests declare, and against a baseline, the stored one or the base commit's run.
 *
 * @module
 */

import type { BenchRecord, BenchResult, BenchTimings } from './bench-result';

/** How much a timing may grow over its baseline before the bench fails. */
export const RATIO = 1.5;

/** Added to every allowance, so a timing near the clock's resolution does not fail by one tick. */
export const SLACK_MS = 0.5;

/** What a judgement found: one line per timing, and whether any of them failed. */
export interface Verdict {
  readonly lines: readonly string[];
  readonly failed: boolean;
}

function isNumberRecord(value: unknown): value is Readonly<Record<string, number>> {
  return (
    typeof value === 'object' &&
    value !== null &&
    Object.values(value).every((entry) => typeof entry === 'number')
  );
}

/** Tells whether a test's meta holds a {@link BenchResult}. */
export function isBenchResult(value: unknown): value is BenchResult {
  return (
    typeof value === 'object' &&
    value !== null &&
    'summary' in value &&
    typeof value.summary === 'string' &&
    'timings' in value &&
    isNumberRecord(value.timings) &&
    (!('budgets' in value) || value.budgets === undefined || isNumberRecord(value.budgets))
  );
}

/** Tells whether parsed JSON is a {@link BenchRecord}. */
export function isBenchRecord(value: unknown): value is BenchRecord {
  return (
    typeof value === 'object' &&
    value !== null &&
    'recorded' in value &&
    typeof value.recorded === 'string' &&
    'machine' in value &&
    typeof value.machine === 'string' &&
    'tests' in value &&
    typeof value.tests === 'object' &&
    value.tests !== null &&
    Object.values(value.tests).every(isNumberRecord)
  );
}

/** The timings of each test, rounded to hundredths of a millisecond. */
export function timingsOf(results: ReadonlyMap<string, BenchResult>): BenchTimings {
  return Object.fromEntries(
    [...results].map(([name, { timings }]) => [
      name,
      Object.fromEntries(
        Object.entries(timings).map(([key, value]) => [key, Math.round(value * 100) / 100])
      ),
    ])
  );
}

/** Judges every timing that has a budget against it. */
export function checkBudgets(results: ReadonlyMap<string, BenchResult>): Verdict {
  const lines: string[] = [];
  let failed = false;

  for (const [name, { timings, budgets = {} }] of results) {
    for (const [key, budget] of Object.entries(budgets)) {
      const value = timings[key];
      const over = value === undefined || value > budget;
      failed ||= over;
      lines.push(
        value === undefined
          ? `${name}: ${key} has a budget of ${budget} ms but was not measured: FAILED`
          : `${name}: ${key} ${value.toFixed(2)} ms of a ${budget} ms budget: ${over ? 'OVER BUDGET' : 'ok'}`
      );
    }
  }

  return { lines, failed };
}

/**
 * Judges every timing against a baseline: it fails past {@link RATIO} times the baseline plus
 * {@link SLACK_MS}, and whenever the two do not hold the same tests and timings, so a test that
 * stopped reporting, or one that never had a baseline, cannot pass unnoticed.
 */
export function compareWithBaseline(results: BenchTimings, baseline: BenchTimings): Verdict {
  const lines: string[] = [];
  let failed = false;
  const fail = (line: string) => {
    lines.push(line);
    failed = true;
  };

  for (const [name, timings] of Object.entries(results)) {
    const stored = baseline[name];

    for (const [key, value] of Object.entries(timings)) {
      const base = stored?.[key];

      if (base === undefined) {
        fail(`${name}: ${key} ${value.toFixed(2)} ms has no baseline: FAILED`);
        continue;
      }

      const limit = RATIO * base + SLACK_MS;
      const line = `${name}: ${key} ${value.toFixed(2)} ms against ${base.toFixed(2)} ms (limit ${limit.toFixed(2)} ms)`;

      if (value > limit) {
        fail(`${line}: REGRESSED`);
      } else {
        lines.push(`${line}: ok`);
      }
    }
  }

  for (const [name, timings] of Object.entries(baseline)) {
    for (const key of Object.keys(timings)) {
      if (results[name]?.[key] === undefined) {
        fail(`${name}: ${key} is in the baseline but was not measured: FAILED`);
      }
    }
  }

  return { lines, failed };
}
