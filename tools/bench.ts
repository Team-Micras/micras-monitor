/**
 * The performance budget: runs the `performance` test project in Chromium and compares each
 * timing its tests report with the baseline stored in `tools/bench-baseline.json`.
 *
 * A timing fails when it grows past {@link RATIO} times its baseline plus {@link SLACK_MS}, the
 * resolution a browser gives `performance.now`; only a relative regression fails, so the numbers
 * hold on any machine that recorded its own baseline. `bun run bench -- --record` runs the tests
 * and stores what they measured as the new baseline.
 *
 * Run with `bun run bench` on an otherwise idle machine; it is not part of `bun run check`,
 * which must not depend on the load of the machine.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { TestCase } from 'vitest/node';
import { startVitest } from 'vitest/node';

/** How much a timing may grow over its baseline before the bench fails. */
const RATIO = 1.5;
/** Added to every allowance, so a timing near the clock's resolution does not fail by one tick. */
const SLACK_MS = 0.5;
const BASELINE = join(import.meta.dirname, 'bench-baseline.json');

/** The stored baseline: the timings of each performance test, by its full name. */
interface Baseline {
  readonly recorded: string;
  readonly machine: string;
  readonly tests: Readonly<Record<string, Readonly<Record<string, number>>>>;
}

/** What a performance test hands the bench through its meta, as `src/app/fixtures/bench.ts` puts it. */
interface Measured {
  readonly timings: Readonly<Record<string, number>>;
  readonly summary: string;
}

async function run(): Promise<{ passed: boolean; tests: TestCase[] }> {
  const vitest = await startVitest('test', [], { project: ['performance'], watch: false });

  try {
    const tests = vitest.state
      .getTestModules()
      .flatMap((module) => Array.from(module.children.allTests()));
    return {
      passed: tests.length > 0 && tests.every((test) => test.result().state === 'passed'),
      tests,
    };
  } finally {
    await vitest.close();
  }
}

function measured(test: TestCase): Measured | undefined {
  const bench: unknown = Reflect.get(test.meta(), 'bench');
  return isMeasured(bench) ? bench : undefined;
}

function isMeasured(value: unknown): value is Measured {
  return (
    typeof value === 'object' &&
    value !== null &&
    'summary' in value &&
    typeof value.summary === 'string' &&
    'timings' in value &&
    typeof value.timings === 'object' &&
    value.timings !== null &&
    Object.values(value.timings).every((timing) => typeof timing === 'number')
  );
}

function readBaseline(): Baseline | undefined {
  let value: unknown;

  try {
    value = JSON.parse(readFileSync(BASELINE, 'utf8'));
  } catch {
    return undefined;
  }

  return isBaseline(value) ? value : undefined;
}

function isBaseline(value: unknown): value is Baseline {
  return (
    typeof value === 'object' &&
    value !== null &&
    'recorded' in value &&
    'machine' in value &&
    'tests' in value &&
    typeof value.tests === 'object' &&
    value.tests !== null
  );
}

function compare(name: string, timings: Readonly<Record<string, number>>, baseline?: Baseline) {
  const stored = baseline?.tests[name];
  let regressed = false;

  for (const [key, value] of Object.entries(timings)) {
    const base = stored?.[key];

    if (base === undefined) {
      console.log(`  ${key.padEnd(16)} ${value.toFixed(2)} ms, no baseline`);
      continue;
    }

    const limit = RATIO * base + SLACK_MS;
    const verdict = value > limit ? 'REGRESSED' : 'ok';
    regressed ||= value > limit;
    console.log(
      `  ${key.padEnd(16)} ${value.toFixed(2)} ms against ${base.toFixed(2)} ms (limit ${limit.toFixed(2)} ms): ${verdict}`
    );
  }

  return regressed;
}

function rounded(timings: Readonly<Record<string, number>>): Record<string, number> {
  return Object.fromEntries(
    Object.entries(timings).map(([key, value]) => [key, Math.round(value * 100) / 100])
  );
}

const { passed, tests } = await run();
const results = tests.flatMap((test) => {
  const bench = measured(test);
  return bench === undefined ? [] : [{ name: test.fullName, bench }];
});
const record = process.argv.includes('--record');
const baseline = readBaseline();
let failed = !passed;

console.log('\nPerformance budget');

if (baseline !== undefined && !record) {
  console.log(`  baseline recorded ${baseline.recorded} on ${baseline.machine}`);
}

for (const { name, bench } of results) {
  console.log(`${name}\n  ${bench.summary}`);

  if (!record) {
    failed = compare(name, bench.timings, baseline) || failed;
  }
}

if (record && passed) {
  const stored: Baseline = {
    recorded: new Date().toISOString().slice(0, 10),
    machine: process.env.BENCH_MACHINE ?? 'reference notebook, headless Chromium',
    tests: Object.fromEntries(results.map(({ name, bench }) => [name, rounded(bench.timings)])),
  };
  writeFileSync(BASELINE, `${JSON.stringify(stored, null, 2)}\n`);
  console.log(`\nStored the baseline in ${BASELINE}`);
}

if (failed) {
  process.exitCode = 1;
}
