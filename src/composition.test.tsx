import { afterEach, describe, expect, test } from 'vitest';
import { render } from 'vitest-browser-react';

import { App } from '@/app/app';
import { createDemoRobot } from '@/app/fake/demo-robot';
import type { FakeRobot, FakeRobotOptions, FakeVariable } from '@/app/fake/fake-robot';
import { createShellStore } from '@/app/state/shell-store';
import '@/app/styles.css';
import type { ShellWindow } from '@/app/windows/types';
import { TypeCode, decodeAccess } from '@/protocol';
import { RobotRegistry } from '@/robot-kit';
import { createDesktop, createWorkspace, leaf } from '@/tiling';
import { micras } from '@robots/micras';
import { EXPLORED_16, FRESH_16 } from '@robots/micras/fixtures/maze-vectors';

const robots: FakeRobot[] = [];

afterEach(() => {
  robots.splice(0).forEach((robot) => robot.disconnect());
});

const MAZE_WINDOW: ShellWindow = {
  id: 'maze',
  kind: 'type-view',
  payload: { variables: ['maze'] },
};

const f32 = (name: string, value: number): FakeVariable => ({
  name,
  type: TypeCode.F32,
  access: decodeAccess(0x01),
  signal: () => value,
});

const ROBOT_WINDOW: ShellWindow = { id: 'robot', kind: 'robot', payload: { variables: [] } };

async function openMaze(
  variables: readonly FakeVariable[],
  options: Partial<FakeRobotOptions> = {},
  window: ShellWindow = MAZE_WINDOW
): Promise<FakeRobot> {
  const robot = createDemoRobot({
    connectMs: 5,
    handshakeMs: 10,
    configureMs: 5,
    commandMs: 5,
    tickMs: 20,
    variables,
    ...options,
  });
  robots.push(robot);
  const store = createShellStore({
    theme: 'dark',
    desktop: createDesktop([createWorkspace('Test', leaf(window.id))], [window]),
  });
  await render(
    <App ports={robot.ports} robots={new RobotRegistry([micras])} store={store} synthetic />
  );
  robot.connect({ transport: 'websocket', url: 'ws://robot' });
  return robot;
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
    let explored = false;
    await openMaze([
      { name: 'state', type: TypeCode.U8, access: decodeAccess(0x01), signal: () => 3 },
      f32('pose/x', 0.09),
      f32('pose/y', 0.27),
      f32('pose/orientation', Math.PI / 2),
      {
        name: 'maze',
        type: TypeCode.BLOB,
        access: decodeAccess(0x08),
        typeTag: 'maze-grid',
        bytes: () => (explored ? EXPLORED_16 : FRESH_16),
      },
      {
        name: 'maze/revision',
        type: TypeCode.U32,
        access: decodeAccess(0x01),
        signal: () => (explored ? 8 : 1),
      },
    ]);

    await expect.poll(() => maze()?.dataset.walls).toBe('65');
    expect(maze()?.dataset.explored).toBe('1');
    await expect.poll(() => maze()?.dataset.robotCell).toBe('0,1');

    explored = true;
    await expect.poll(() => maze()?.dataset.walls).toBe('68');
    expect(maze()?.dataset.explored).toBe('2');
  });

  test('fits the maze in its window with square cells', async () => {
    await openMaze([
      {
        name: 'maze',
        type: TypeCode.BLOB,
        access: decodeAccess(0x08),
        typeTag: 'maze-grid',
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
          type: TypeCode.U8,
          access: decodeAccess(0x01),
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
    expect(document.querySelector('[data-robot-state]')?.textContent).toBe('IDLE');
  });
});
