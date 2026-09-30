/**
 * Compares bench runs of a change with bench runs of its base, as CI does on one runner: each
 * side's timings are the best of its runs (`bestOf`), and only a timing both sides measured and
 * the head made more than 1.5 times plus 0.5 ms slower fails. Benches only one side has are
 * noted, so a change may add, rename or remove one. Absolute budgets are not judged here.
 *
 * Run with `bun tools/bench-diff.ts --base <file> [--base <file>] --head <file> [--head <file>]`,
 * each file written by `bun run bench -- --output <file>`.
 */

import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

import { bestOf, compareWithBaseline, isBenchRecord } from './bench-compare';
import type { BenchTimings } from './bench-result';

function timingsIn(path: string): BenchTimings {
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'));

  if (!isBenchRecord(value)) {
    throw new Error(`${path} holds no bench timings`);
  }

  return value.tests;
}

const { values } = parseArgs({
  options: {
    base: { type: 'string', multiple: true, default: [] },
    head: { type: 'string', multiple: true, default: [] },
  },
});

if (values.base.length === 0 || values.head.length === 0) {
  throw new Error('Give at least one --base and one --head file.');
}

const verdict = compareWithBaseline(
  bestOf(values.head.map(timingsIn)),
  bestOf(values.base.map(timingsIn)),
  'shared'
);
console.log(
  `The head, best of ${values.head.length}, against the base, best of ${values.base.length}`
);
verdict.lines.forEach((line) => console.log(`  ${line}`));

if (verdict.failed) {
  process.exitCode = 1;
}
