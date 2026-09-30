/**
 * Eight live plots of the demo robot's 1 kHz signals in a 4 × 2 grid, the plan's reference load,
 * for the plots' smoke test and their performance test.
 *
 * @module
 */

import { expect } from 'vitest';
import { render } from 'vitest-browser-react';

import { RobotRegistry } from '@/robot-kit';
import type { Scheduler } from '@/telemetry';
import { createDesktop, createWorkspace, leaf, split, type TileNode } from '@/tiling';

import { App } from '../app';
import { createDemoRobot } from '../fake/demo-robot';
import type { FakeRobot } from '../fake/fake-robot';
import { createShellStore } from '../state/shell-store';
import '../styles.css';
import type { ShellWindow } from '../windows/types';

/** How many plots, each with two signals. */
export const PLOTS = 8;

/** Samples per second of every signal. */
export const RATE_HZ = 1000;

/** The first signal of the first plot, to count what the store holds. */
export const COUNTED_SIGNAL = 'pose/linear_speed';

const SIGNALS = [
  [COUNTED_SIGNAL, 'reference/linear_speed'],
  ['pose/angular_speed', 'reference/angular_speed'],
  ['wall/0', 'wall/1'],
  ['wall/2', 'wall/3'],
  ['imu/gyro_z', 'imu/accel_x'],
  ['control/along_error', 'control/across_error'],
  ['pose/x', 'reference/x'],
  ['pose/orientation', 'reference/orientation'],
];

function grid(ids: readonly string[]): TileNode {
  const row = (from: number) =>
    split(
      'row',
      0.5,
      split('row', 0.5, leaf(ids[from]), leaf(ids[from + 1])),
      split('row', 0.5, leaf(ids[from + 2]), leaf(ids[from + 3]))
    );
  return split('column', 0.5, row(0), row(4));
}

/**
 * Renders the app with the eight plots and connects the demo robot, sending a batch of 16
 * samples every 16 ms.
 *
 * @param scheduler When the store tells the plots about new samples; every animation frame by default.
 * @returns The robot, streaming.
 */
export async function renderEightPlots(scheduler?: Scheduler): Promise<FakeRobot> {
  const robot = createDemoRobot({
    connectMs: 5,
    handshakeMs: 10,
    configureMs: 5,
    tickMs: 16,
    samplesPerTick: 16,
    scheduler,
  });
  const windows: ShellWindow[] = SIGNALS.map((variables, index) => ({
    id: `plot-${index}`,
    kind: 'plot',
    payload: { variables },
  }));
  const store = createShellStore({
    theme: 'dark',
    desktop: createDesktop(
      [createWorkspace('Plots', grid(windows.map((window) => window.id)))],
      windows
    ),
  });
  await render(<App ports={robot.ports} robots={new RobotRegistry([])} store={store} synthetic />);
  robot.connect({ transport: 'websocket', url: 'ws://robot' });
  await expect.poll(() => robot.ports.connection.status()).toMatchObject({ phase: 'streaming' });
  return robot;
}

/** The samples the store holds of the counted signal. */
export function storedSamples(robot: FakeRobot): number {
  return robot.store.variable(COUNTED_SIGNAL)?.storedSamples ?? 0;
}
