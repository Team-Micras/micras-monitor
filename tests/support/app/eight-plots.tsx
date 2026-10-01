/**
 * Eight live plots of the demo robot's 1 kHz signals in a 4 × 2 grid, the plan's reference load,
 * for the plots' smoke test and their performance test.
 *
 * @module
 */

import { expect } from 'vitest';
import { render } from 'vitest-browser-react';

import { RobotRegistry } from '@/core/robot';
import type { Scheduler } from '@/history';
import { createDesktop, createWorkspace, leaf, split, type TileNode } from '@/tiling';

import { App } from '@/app/app';
import type { AppMonitor } from '@/app/monitor-context';
import { createShellStore } from '@/app/state/shell-store';
import '@/app/styles.css';
import type { ShellWindow } from '@/app/windows/types';
import { DEMO_TARGET, demoMonitor } from '@tests/support/sources/demo-monitor';

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
 * Renders the app with the eight plots and connects the demo robot, streaming at 1 kHz in a
 * batch of 16 samples every 16 ms.
 *
 * @param scheduler When the store tells the plots about new samples; every animation frame by default.
 * @returns The live monitor, streaming.
 */
export async function renderEightPlots(scheduler?: Scheduler): Promise<AppMonitor> {
  const monitor = demoMonitor({ sampleRateHz: RATE_HZ, scheduler });
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
  await render(<App monitor={monitor} robots={new RobotRegistry([])} store={store} synthetic />);
  monitor.connect(DEMO_TARGET);
  await expect.poll(() => monitor.state.status.kind).toBe('linked');
  return monitor;
}

/** The samples the history holds of the counted signal. */
export function storedSamples(monitor: AppMonitor): number {
  return monitor.history.variable(COUNTED_SIGNAL)?.storedSamples ?? 0;
}
