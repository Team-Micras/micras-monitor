import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { configDefaults, type TestProjectInlineConfiguration } from 'vitest/config';
import { describe, expect, test } from 'vitest';

import config from '../vite.config';

const ROOT = join(import.meta.dirname, '..');
const { scripts }: { scripts: Record<string, string> } = JSON.parse(
  readFileSync(join(ROOT, 'package.json'), 'utf8')
);

function project(name: string): NonNullable<TestProjectInlineConfiguration['test']> {
  const found = config.test?.projects
    ?.filter((entry): entry is TestProjectInlineConfiguration => typeof entry === 'object')
    .find((entry) => entry.test?.name === name);

  if (found?.test === undefined) {
    throw new Error(`No test project named ${name}`);
  }

  return found.test;
}

describe('The build', () => {
  test('warns about a chunk a little over the largest one shipped, not at Vite’s 500 kB', () => {
    expect(config.build?.chunkSizeWarningLimit).toBeLessThan(500);
  });
});

describe('The test projects', () => {
  test.each(['unit', 'browser'])('%s keeps the default exclusions', (name) => {
    expect(project(name).exclude).toEqual(expect.arrayContaining([...configDefaults.exclude]));
  });

  test.each([
    ['unit', 6],
    ['browser', 4],
    ['performance', 1],
    ['e2e', 1],
  ])('%s runs at most %i files at once, in a group of its own', (name, workers) => {
    expect(project(name).maxWorkers).toBe(workers);
    const orders = ['unit', 'browser', 'performance', 'e2e'].map(
      (other) => project(other).sequence?.groupOrder
    );
    expect(new Set(orders).size).toBe(orders.length);
  });

  test('performance runs against the simulated robot with room to start it', () => {
    expect(project('performance')).toMatchObject({
      globalSetup: ['tools/browser-setup.ts'],
      hookTimeout: 60_000,
    });
  });

  test('the check runs no performance test, which only the bench runs', () => {
    const check = scripts.check
      .split('&&')
      .map((step) => step.trim().replace(/^bun run /, ''))
      .map((step) => scripts[step] ?? step)
      .join(' ');
    expect(check).not.toMatch(/performance|bench/);
    expect(scripts.bench).toBe('bun tools/bench.ts');
  });
});
