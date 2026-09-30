import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { configDefaults, type TestProjectInlineConfiguration } from 'vitest/config';
import { createVitest } from 'vitest/node';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import config, { CHUNK_SIZE_WARNING_KB } from '../vite.config';

const ROOT = join(import.meta.dirname, '..');
const PERFORMANCE_FILE = /-performance\.test\.tsx?$/;
const ORDER = ['unit', 'browser', 'performance', 'e2e'] as const;
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

function expand(script: string): string {
  return script
    .split('&&')
    .map((step) => step.trim())
    .map((step) => {
      const name = /^bun run (\S+)$/.exec(step)?.[1];
      return name !== undefined && scripts[name] !== undefined ? expand(scripts[name]) : step;
    })
    .join(' && ');
}

function projectsRunBy(script: string): string[] {
  return [...expand(script).matchAll(/--project (\S+)/g)].map(([, name]) => name);
}

const files = new Map<string, string[]>();

beforeAll(async () => {
  const vitest = await createVitest('test', { watch: false, root: ROOT });

  try {
    for (const specification of await vitest.globTestSpecifications()) {
      const name = specification.project.name.replace(/ \(.*\)$/, '');
      files.set(name, [...(files.get(name) ?? []), specification.moduleId]);
    }
  } finally {
    await vitest.close();
  }
});

afterAll(() => files.clear());

describe('The build', () => {
  test('warns about the chunk size past the limit bundle-size reports against', () => {
    expect(config.build?.chunkSizeWarningLimit).toBe(CHUNK_SIZE_WARNING_KB);
    expect(CHUNK_SIZE_WARNING_KB).toBeLessThan(500);
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
  ])('%s runs at most %i files at once', (name, workers) => {
    expect(project(name).maxWorkers).toBe(workers);
  });

  test('run one after the other: unit, browser, performance, then e2e', () => {
    const orders = ORDER.map((name) => project(name).sequence?.groupOrder ?? 0);
    expect(orders).toEqual(orders.toSorted((left, right) => left - right));
    expect(new Set(orders).size).toBe(ORDER.length);
  });

  test('performance runs against the simulated robot with room to start it', () => {
    expect(project('performance')).toMatchObject({
      globalSetup: ['tools/browser-setup.ts'],
      hookTimeout: 60_000,
    });
  });

  test('performance resolves the performance tests and nothing else', () => {
    const performance = files.get('performance') ?? [];
    expect(performance.length).toBeGreaterThan(0);
    expect(performance.every((file) => PERFORMANCE_FILE.test(file))).toBe(true);
  });

  test.each(['unit', 'browser', 'e2e'])('%s resolves no performance test', (name) => {
    const resolved = files.get(name) ?? [];
    expect(resolved.length).toBeGreaterThan(0);
    expect(resolved.filter((file) => PERFORMANCE_FILE.test(file))).toEqual([]);
  });

  test('the check runs no performance test, which only the bench runs', () => {
    const checked = projectsRunBy(scripts.check);
    expect(checked.toSorted()).toEqual(['browser', 'e2e', 'unit']);
    expect(
      checked.flatMap((name) => files.get(name) ?? []).filter((file) => PERFORMANCE_FILE.test(file))
    ).toEqual([]);
    expect(expand(scripts.check)).not.toMatch(/bench/);
    expect(projectsRunBy(scripts.bench)).toEqual([]);
    expect(scripts.bench).toBe('bun tools/bench.ts');
  });
});
