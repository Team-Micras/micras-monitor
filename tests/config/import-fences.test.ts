import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterAll, beforeAll, describe, expect, test } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..');
const OXLINT = join(ROOT, 'node_modules', '.bin', 'oxlint');

/** A file of the tree, an import it makes, and whether the fences of `.oxlintrc.json` refuse it. */
type Fence = readonly [file: string, specifier: string, refused: boolean];

const FENCES: readonly Fence[] = [
  ['src/core/probe.ts', '../variables', false],
  ['src/core/probe.ts', '@/core/variables', true],
  ['src/core/probe.ts', '@/history', true],
  ['src/core/probe.ts', '../history', true],
  ['src/core/probe.ts', '@/recording', true],
  ['src/core/probe.ts', '@/tiling', true],
  ['src/core/probe.ts', '@/sources/demo/demo-source', true],
  ['src/core/probe.ts', '@/robots/micras', true],
  ['src/core/probe.ts', '@/ui/app', true],
  ['src/core/probe.ts', 'react', true],
  ['src/core/probe.ts', '@tests/support/virtual-time', true],
  ['src/core/robot/deep/probe.ts', '../../variables', false],
  ['src/core/robot/deep/probe.ts', '../../../ui/app', true],
  ['src/core/robot/deep/probe.ts', '../../../../scripts/bench', true],

  ['src/history/probe.ts', '@/core/variables', false],
  ['src/history/probe.ts', './block', false],
  ['src/history/probe.ts', '@/recording', true],
  ['src/history/probe.ts', '../recording', true],
  ['src/history/probe.ts', '@/tiling', true],
  ['src/history/probe.ts', '@/sources/micras-comm/link/robot-link', true],
  ['src/history/probe.ts', '@/robots/micras', true],
  ['src/history/probe.ts', '@/ui/app', true],
  ['src/history/probe.ts', 'react', true],
  ['src/history/memory/deep/probe.ts', '../../../recording/recording', true],
  ['src/history/memory/deep/probe.ts', '../../block', false],

  ['src/recording/probe.ts', '@/core/variables', false],
  ['src/recording/probe.ts', '@/history', false],
  ['src/recording/probe.ts', '@/tiling', true],
  ['src/recording/probe.ts', '@/sources/demo/demo-source', true],
  ['src/recording/probe.ts', '@/robots/micras', true],
  ['src/recording/probe.ts', '@/ui/app', true],
  ['src/recording/probe.ts', '../ui/app', true],
  ['src/recording/probe.ts', 'react', true],
  ['src/recording/library/deep/probe.ts', '@/history/history-store', false],
  ['src/recording/library/deep/probe.ts', '../../recording', false],
  ['src/recording/library/deep/probe.ts', '../../../ui/recordings/recordings-dialog', true],

  ['src/tiling/probe.ts', './tree', false],
  ['src/tiling/probe.ts', '@/core/variables', true],
  ['src/tiling/probe.ts', '../core/variables', true],
  ['src/tiling/probe.ts', '@/ui/tiling/tiling-view', true],
  ['src/tiling/probe.ts', 'react', true],
  ['src/tiling/deep/probe.ts', '../../history', true],

  ['src/sources/micras-comm/probe.ts', '@/core/source', false],
  ['src/sources/micras-comm/probe.ts', './link', false],
  ['src/sources/micras-comm/probe.ts', '@/history', true],
  ['src/sources/micras-comm/probe.ts', '@/recording', true],
  ['src/sources/micras-comm/probe.ts', '@/tiling', true],
  ['src/sources/micras-comm/probe.ts', '@/robots/micras', true],
  ['src/sources/micras-comm/probe.ts', '@/ui/app', true],
  ['src/sources/micras-comm/probe.ts', '../../ui/app', true],
  ['src/sources/micras-comm/probe.ts', '@/sources/demo/demo-source', true],
  ['src/sources/micras-comm/probe.ts', '../demo/demo-source', true],
  ['src/sources/micras-comm/probe.ts', 'react', true],
  ['src/sources/micras-comm/link/deep/probe.ts', '../../wire', false],
  ['src/sources/micras-comm/link/deep/probe.ts', '../../../demo/demo-source', true],
  ['src/sources/micras-comm/link/deep/probe.ts', '../../../../history', true],
  ['src/sources/demo/probe.ts', '@/core/source', false],
  ['src/sources/demo/probe.ts', '@/sources/micras-comm/link/robot-link', true],
  ['src/sources/demo/probe.ts', '../micras-comm/link/robot-link', true],
  ['src/sources/demo/probe.ts', '@/history', true],
  ['src/sources/demo/probe.ts', '@/ui/app', true],
  ['src/sources/serial/link/deep/probe.ts', '../../frame', false],
  ['src/sources/serial/link/deep/probe.ts', '@/sources/demo/demo-source', true],
  ['src/sources/serial/link/deep/probe.ts', '../../../demo/demo-source', true],
  ['src/sources/serial/link/deep/probe.ts', '@/sources/micras-comm/link/robot-link', true],
  ['src/sources/serial/link/deep/probe.ts', '../../../micras-comm/link/robot-link', true],
  ['src/sources/serial/probe.ts', '../demo/demo-source', true],
  ['src/sources/serial/probe.ts', '../micras-comm/micras-comm-source', true],
  ['src/sources/micras-comm/transports/bluetooth/probe.ts', '@/sources/serial/serial-source', true],
  ['src/sources/micras-comm/transports/bluetooth/probe.ts', '../../../serial/serial-source', true],
  ['src/sources/micras-comm/transports/bluetooth/probe.ts', '../transport', false],
  ['src/sources/demo/deep/probe.ts', '@/sources/micras-comm/link/robot-link', true],
  ['src/sources/demo/deep/probe.ts', '../../micras-comm/link/robot-link', true],
  ['src/sources/demo/deep/probe.ts', '../../../ui/app', true],
  ['src/sources/another/deep/probe.ts', '@/core/source', false],
  ['src/sources/another/deep/probe.ts', '../../../../ui/app', true],
  ['src/sources/another/deep/probe.ts', '@/history', true],
  ['src/sources/another/deep/probe.ts', '@/recording', true],
  ['src/sources/another/deep/probe.ts', 'react', true],

  ['src/robots/micras/probe.ts', '@/core/robot', false],
  ['src/robots/micras/probe.ts', '@/core/variables', false],
  ['src/robots/micras/probe.ts', 'react', false],
  ['src/robots/micras/probe.ts', './maze', false],
  ['src/robots/micras/probe.ts', '@/ui/lazy/lazy-with-retry', true],
  ['src/robots/micras/probe.ts', '@/ui/app', true],
  ['src/robots/micras/probe.ts', '@/ui/state/shell-store', true],
  ['src/robots/micras/probe.ts', '@/ui/windows/plot/plot-window', true],
  ['src/robots/micras/probe.ts', '../../ui/lazy/lazy-with-retry', true],
  ['src/robots/micras/probe.ts', '@/history', true],
  ['src/robots/micras/probe.ts', '@/recording', true],
  ['src/robots/micras/probe.ts', '@/tiling', true],
  ['src/robots/micras/probe.ts', '@/sources/micras-comm/link/robot-link', true],
  ['src/robots/micras/probe.ts', '../../sources/demo/demo-source', true],
  ['src/robots/micras/probe.ts', '@/robots/other', true],
  ['src/robots/micras/deep/probe.ts', '../../../ui/state/shell-store', true],

  ['src/ui/probe.ts', '@/core/monitor', false],
  ['src/ui/probe.ts', '@/core/robot', false],
  ['src/ui/probe.ts', '@/history', false],
  ['src/ui/probe.ts', '@/recording', false],
  ['src/ui/probe.ts', '@/tiling', false],
  ['src/ui/probe.ts', 'react', false],
  ['src/ui/probe.ts', '@/sources/micras-comm/link/robot-link', true],
  ['src/ui/probe.ts', '../sources/demo/demo-source', true],
  ['src/ui/probe.ts', '@/robots/micras', true],
  ['src/ui/probe.ts', '../main', true],
  ['src/ui/probe.ts', '@tests/support/virtual-time', true],
  ['src/ui/windows/plot/probe.ts', '../../../sources/micras-comm/link/robot-link', true],
  ['src/ui/windows/plot/probe.ts', '../robot/robot-window', false],
  ['src/ui/windows/plot/probe.ts', '../../tiling/tiling-view', false],

  ['src/main.tsx', '@/sources/micras-comm/micras-comm-source', false],
  ['src/main.tsx', '@/robots/micras', false],
  ['src/main.tsx', '@/ui/app', false],
  ['src/main.tsx', '@/recording/library/browser-recordings', false],
  ['src/main.tsx', '@tests/support/virtual-time', true],

  ['scripts/probe.ts', '../src/sources/micras-comm/link/robot-link', false],
  ['scripts/probe.ts', '../src/core/source', false],
  ['scripts/probe.ts', '../src/history', true],
  ['scripts/probe.ts', '../src/ui/app', true],
  ['scripts/probe.ts', '@tests/support/virtual-time', true],
  ['scripts/probe.ts', 'react', true],
  ['scripts/simulated-robot/probe.ts', '../../src/sources/micras-comm/wire', false],
  ['scripts/simulated-robot/probe.ts', '../../src/sources/micras-comm/wire/frame', false],
  ['scripts/simulated-robot/probe.ts', '@/sources/micras-comm/wire/frame', false],
  ['scripts/simulated-robot/probe.ts', './wire', false],
  ['scripts/simulated-robot/probe.ts', '../../src/sources/micras-comm/link/robot-link', true],
  ['scripts/simulated-robot/probe.ts', '../../src/sources/micras-comm/value-types', true],
  ['scripts/simulated-robot/probe.ts', '@/sources/micras-comm/link/robot-link', true],
  ['scripts/simulated-robot/probe.ts', '../../src/core/variables', true],
  ['scripts/bench-history.ts', '../src/history', false],
  ['scripts/bench-history.ts', '../src/recording', true],

  ['tests/probe.test.ts', '@/sources/micras-comm/link/robot-link', false],
  ['tests/probe.test.ts', '@/ui/app', false],
  ['tests/probe.test.ts', '@scripts/simulated-robot/server', false],
  ['tests/sources/micras-comm/micras-comm-source.test.ts', '@/ui/app', true],
];

const refused = new Map<string, Set<string>>();

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), 'import-fences-'));
  const config = JSON.parse(readFileSync(join(ROOT, '.oxlintrc.json'), 'utf8'));
  delete config.$schema;
  config.options = { ...config.options, typeAware: false, denyWarnings: false };
  writeFileSync(join(dir, '.oxlintrc.json'), JSON.stringify(config));

  const files = new Map<string, string[]>();
  for (const [file, specifier] of FENCES) {
    files.set(file, [...(files.get(file) ?? []), specifier]);
  }

  for (const [file, specifiers] of files) {
    const lines = specifiers.map(
      (specifier, index) => `import * as p${index} from '${specifier}';`
    );
    lines.push(`export const probes = [${specifiers.map((_, index) => `p${index}`).join(', ')}];`);
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), `${lines.join('\n')}\n`);
  }

  const run = spawnSync(OXLINT, ['-c', '.oxlintrc.json', '-f', 'json', ...files.keys()], {
    cwd: dir,
    encoding: 'utf8',
  });
  rmSync(dir, { recursive: true, force: true });

  const report: { diagnostics: { code: string; filename: string; message: string }[] } = JSON.parse(
    run.stdout
  );
  for (const { code, filename, message } of report.diagnostics) {
    const specifier = /^'([^']+)' import is restricted/.exec(message)?.[1];
    if (code === 'eslint(no-restricted-imports)' && specifier !== undefined) {
      refused.set(filename, (refused.get(filename) ?? new Set()).add(specifier));
    }
  }
});

afterAll(() => refused.clear());

describe('the import fences of .oxlintrc.json', () => {
  test.each(FENCES)('%s importing %s is refused: %s', (file, specifier, expected) => {
    expect(refused.get(file)?.has(specifier) ?? false).toBe(expected);
  });
});
