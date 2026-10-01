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
 * How a baseline is held to the tests that ran: `strict` for the stored baseline, where a test or
 * timing on one side only fails, since it means the baseline is stale; `shared` for the base
 * commit's run, where a bench added, renamed or removed by the change under test is only noted.
 */
export type BaselineMode = 'strict' | 'shared';

/**
 * Judges every timing against a baseline: it fails past {@link RATIO} times the baseline plus
 * {@link SLACK_MS}. A test or timing on one side only fails in `strict` mode and is a notice in
 * `shared` mode, so a baseline cannot go stale unnoticed while a change that adds a bench can
 * still be compared with a base commit that lacks it. Two runs that share no timing at all fail in
 * either mode, since nothing was compared.
 */
export function compareWithBaseline(
  results: BenchTimings,
  baseline: BenchTimings,
  mode: BaselineMode = 'strict'
): Verdict {
  const lines: string[] = [];
  let failed = false;
  let compared = 0;
  const fail = (line: string) => {
    lines.push(line);
    failed = true;
  };
  const unmatched = (line: string) =>
    mode === 'strict' ? fail(`${line}: FAILED`) : lines.push(`${line}: notice`);

  for (const [name, timings] of Object.entries(results)) {
    const stored = baseline[name];

    for (const [key, value] of Object.entries(timings)) {
      const base = stored?.[key];

      if (base === undefined) {
        unmatched(`${name}: ${key} ${value.toFixed(2)} ms has no baseline`);
        continue;
      }

      compared += 1;
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
        unmatched(`${name}: ${key} is in the baseline but was not measured`);
      }
    }
  }

  if (compared === 0) {
    fail('No timing was measured on both sides: FAILED');
  }

  return { lines, failed };
}

/**
 * The best of several runs: each timing at its lowest over the runs that measured it, so a
 * reading taken while the machine was busy counts for less.
 */
export function bestOf(runs: readonly BenchTimings[]): BenchTimings {
  const best: Record<string, Record<string, number>> = {};

  for (const run of runs) {
    for (const [name, timings] of Object.entries(run)) {
      const kept = (best[name] ??= {});

      for (const [key, value] of Object.entries(timings)) {
        kept[key] = Math.min(kept[key] ?? Number.POSITIVE_INFINITY, value);
      }
    }
  }

  return best;
}
