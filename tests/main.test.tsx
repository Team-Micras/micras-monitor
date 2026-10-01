import { afterEach, describe, expect, test } from 'vitest';
import { render } from 'vitest-browser-react';

import { App } from '@/ui/app';
import type { AppMonitor } from '@/ui/monitor-context';
import { createShellStore } from '@/ui/state/shell-store';
import '@/ui/styles.css';
import type { ShellWindow } from '@/ui/windows/types';
import { RobotRegistry } from '@/core/robot';
import { createDesktop, createWorkspace, leaf } from '@/tiling';
import { micras } from '@/robots/micras';
import type { DemoRobot, DemoVariable } from '@/sources/demo/demo-source';
import { EXPLORED_16, FRESH_16 } from '@tests/support/robots/micras/maze-vectors';
import { DEMO_TARGET, demoMonitor } from '@tests/support/sources/demo-monitor';
import { storedSamples } from '@tests/support/history/sample-counts';

const monitors: AppMonitor[] = [];

afterEach(() => {
  monitors.splice(0).forEach((monitor) => monitor.disconnect());
});

const MAZE_WINDOW: ShellWindow = {
  id: 'maze',
  kind: 'blob-view',
  payload: { variables: ['maze'] },
};

const f32 = (name: string, value: number): DemoVariable => ({
  name,
  type: 'f32',
  access: { stream: true, write: false, writeNeedsIdle: false, persists: false },
  signal: () => value,
});

const ROBOT_WINDOW: ShellWindow = { id: 'robot', kind: 'robot', payload: { variables: [] } };

async function openMaze(
  variables: readonly DemoVariable[],
  robot: Partial<DemoRobot> = {},
  window: ShellWindow = MAZE_WINDOW
): Promise<AppMonitor> {
  const monitor = demoMonitor({ sampleRateHz: 50, robot: { variables, ...robot } });
  monitors.push(monitor);
  const store = createShellStore({
    theme: 'dark',
    desktop: createDesktop([createWorkspace('Test', leaf(window.id))], [window]),
  });
  await render(
    <App monitor={monitor} robots={new RobotRegistry([micras])} store={store} synthetic />
  );
  monitor.connect(DEMO_TARGET);
  return monitor;
}

function maze(): SVGSVGElement | null {
  return document.querySelector<SVGSVGElement>('[data-maze]');
}

function timeline(): string {
  return [...document.querySelectorAll('ol[aria-label="State transitions"] li span.truncate')]
    .map((item) => item.textContent)
    .join(' ');
}

describe('the Micras package in the app', () => {
  test('draws the maze the robot sends and reads it again when its revision moves', async () => {
    let blob = FRESH_16;
    let revision = 1;
    const monitor = await openMaze([
      {
        name: 'state',
        type: 'u8',
        access: { stream: true, write: false, writeNeedsIdle: false, persists: false },
        signal: () => 3,
      },
      f32('pose/x', 0.09),
      f32('pose/y', 0.27),
      f32('pose/orientation', Math.PI / 2),
      {
        name: 'maze',
        type: 'bytes',
        access: { stream: false, write: false, writeNeedsIdle: false, persists: true },
        tag: 'maze-grid',
        bytes: () => blob,
      },
      {
        name: 'maze/revision',
        type: 'u32',
        access: { stream: true, write: false, writeNeedsIdle: false, persists: false },
        signal: () => revision,
      },
    ]);

    await expect.poll(() => maze()?.dataset.walls).toBe('65');
    expect(maze()?.dataset.explored).toBe('1');
    await expect.poll(() => maze()?.dataset.robotCell).toBe('0,1');

    blob = EXPLORED_16;
    const revisions = () => storedSamples(monitor.history, 'maze/revision');
    const seen = revisions();
    await expect.poll(revisions).toBeGreaterThan(seen + 10);
    expect(maze()?.dataset.walls).toBe('65');

    revision = 8;
    await expect.poll(() => maze()?.dataset.walls).toBe('68');
    expect(maze()?.dataset.explored).toBe('2');
  });

  test('fits the maze in its window with square cells', async () => {
    await openMaze([
      {
        name: 'maze',
        type: 'bytes',
        access: { stream: false, write: false, writeNeedsIdle: false, persists: true },
        tag: 'maze-grid',
        bytes: () => FRESH_16,
      },
    ]);

    await expect.poll(() => maze()?.dataset.walls).toBe('65');
    const frame = document.querySelector('[data-maze]')?.closest('section, [data-window]');
    const box = maze()?.getBoundingClientRect();
    const walls = maze()?.querySelector('path.stroke-foreground')?.getBoundingClientRect();

    expect(box).toBeDefined();
    expect(walls?.width ?? 0).toBeGreaterThan(300);
    expect(walls?.width ?? 0).toBeCloseTo(walls?.height ?? 0, 0);
    expect(walls?.bottom ?? Infinity).toBeLessThanOrEqual(
      frame?.getBoundingClientRect().bottom ?? 0
    );
  });

  test('keeps a state shorter than a sample on the timeline, from the robot log', async () => {
    await openMaze(
      [
        {
          name: 'state',
          type: 'u8',
          access: { stream: true, write: false, writeNeedsIdle: false, persists: false },
          signal: (seconds) => (seconds < 0.4 ? 3 : 1),
        },
      ],
      {
        logs: [
          { atSeconds: 0.3, severity: 'info', text: 'state SAVE' },
          { atSeconds: 0.31, severity: 'info', text: 'state RUN' },
          { atSeconds: 0.4, severity: 'info', text: 'state IDLE' },
        ],
      },
      ROBOT_WINDOW
    );

    await expect.poll(timeline).toBe('RUN SAVE RUN IDLE');
    await expect.poll(() => document.querySelector('[data-robot-state]')?.textContent).toBe('IDLE');
  });
});
