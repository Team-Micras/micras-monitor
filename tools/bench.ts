/**
 * The performance budget: runs the `performance` test project in Chromium and judges each timing
 * its tests report twice (`tools/bench-compare.ts`): against the absolute budget a test declares,
 * such as the plan's 8 ms p95 of frame work, and against a baseline, failing past 1.5 times it
 * plus 0.5 ms, so a relative regression fails on any machine that measured its own baseline.
 *
 * The baseline is `tools/bench-baseline.json`, this notebook's, unless `--against <file>` names
 * the results of another run, as CI does with the base commit's on the same runner.
 *
 * - `bun run bench` judges a run against the stored baseline.
 * - `bun run bench -- --record` stores the run as the new baseline, named after this host or
 *   `BENCH_MACHINE`.
 * - `bun run bench -- --output <file>` writes the run's timings to a file and judges only the
 *   budgets, as CI does for the base commit.
 * - `bun run bench -- --against <file>` judges the run against that file instead of the stored
 *   baseline.
 *
 * Run it on an otherwise idle machine; it is not part of `bun run check`, which must not depend
 * on the load of the machine.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

import { startVitest, type TestCase } from 'vitest/node';

import {
  checkBudgets,
  compareWithBaseline,
  isBenchRecord,
  isBenchResult,
  timingsOf,
  type Verdict,
} from './bench-compare';
import type { BenchRecord, BenchResult } from './bench-result';

const STORED_BASELINE = join(import.meta.dirname, 'bench-baseline.json');

async function run(): Promise<{ passed: boolean; results: Map<string, BenchResult> }> {
  const vitest = await startVitest('test', [], { project: ['performance'], watch: false });

  try {
    const tests: TestCase[] = vitest.state
      .getTestModules()
      .flatMap((module) => Array.from(module.children.allTests()));
    const results = new Map<string, BenchResult>();

    for (const test of tests) {
      const bench: unknown = Reflect.get(test.meta(), 'bench');

      if (isBenchResult(bench)) {
        results.set(test.fullName, bench);
      }
    }

    return {
      passed: tests.length > 0 && tests.every((test) => test.result().state === 'passed'),
      results,
    };
  } finally {
    await vitest.close();
  }
}

function readRecord(path: string): BenchRecord {
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'));

  if (!isBenchRecord(value)) {
    throw new Error(`${path} holds no bench timings`);
  }

  return value;
}

function writeRecord(path: string, record: BenchRecord): void {
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);
}

function localDate(): string {
  return new Date().toLocaleDateString('sv-SE');
}

function print(title: string, verdict: Verdict): void {
  console.log(`\n${title}`);
  verdict.lines.forEach((line) => console.log(`  ${line}`));
}

const { values: options } = parseArgs({
  options: {
    record: { type: 'boolean', default: false },
    output: { type: 'string' },
    against: { type: 'string' },
  },
});
const { passed, results } = await run();
const record: BenchRecord = {
  recorded: localDate(),
  machine: process.env.BENCH_MACHINE ?? hostname(),
  tests: timingsOf(results),
};

console.log('\nPerformance budget');
results.forEach(({ summary }, name) => console.log(`${name}\n  ${summary}`));

const budgets = checkBudgets(results);
print('Absolute budgets', budgets);
let failed = !passed || budgets.failed;

if (options.output !== undefined) {
  writeRecord(options.output, record);
}

if (options.record) {
  if (!failed) {
    writeRecord(STORED_BASELINE, record);
    console.log(`\nStored the baseline in ${STORED_BASELINE}`);
  }
} else if (options.against !== undefined || options.output === undefined) {
  const baseline = readRecord(options.against ?? STORED_BASELINE);
  const verdict = compareWithBaseline(record.tests, baseline.tests);
  print(`Against the baseline of ${baseline.recorded} on ${baseline.machine}`, verdict);
  failed ||= verdict.failed;
}

if (failed) {
  process.exitCode = 1;
}
