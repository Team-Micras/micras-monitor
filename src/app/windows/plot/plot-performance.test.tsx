import { expect, test } from 'vitest';
import { render } from 'vitest-browser-react';

import { RobotRegistry } from '@/robot-kit';
import type { Scheduler } from '@/telemetry';
import { createDesktop, createWorkspace, leaf, split, type TileNode } from '@/tiling';

import { App } from '../../app';
import { createDemoRobot } from '../../fake/demo-robot';
import { createShellStore } from '../../state/shell-store';
import '../../styles.css';
import type { ShellWindow } from '../types';

const PLOTS = 8;
const RUN_MS = 5000;
const SIGNALS = [
  ['pose/linear_speed', 'reference/linear_speed'],
  ['pose/angular_speed', 'reference/angular_speed'],
  ['wall/0', 'wall/1'],
  ['wall/2', 'wall/3'],
  ['imu/gyro_z', 'imu/accel_x'],
  ['control/along_error', 'control/across_error'],
  ['pose/x', 'reference/x'],
  ['pose/orientation', 'reference/orientation'],
];

function percentile(values: readonly number[], share: number): number {
  const sorted = values.toSorted((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(share * sorted.length))] ?? Number.NaN;
}

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

test('eight live plots of 1 kHz signals draw within the frame budget', async ({ annotate }) => {
  const work: number[] = [];
  const intervals: number[] = [];
  const scheduler: Scheduler = {
    schedule: (task) =>
      requestAnimationFrame(() => {
        const started = performance.now();
        task();
        work.push(performance.now() - started);
      }),
  };
  const robot = createDemoRobot({
    connectMs: 5,
    handshakeMs: 10,
    configureMs: 5,
    tickMs: 16,
    samplesPerTick: 16,
    scheduler,
  });
  const windows: ShellWindow[] = SIGNALS.slice(0, PLOTS).map((variables, index) => ({
    id: `plot-${index}`,
    kind: 'plot',
    payload: { variables },
  }));
  const store = createShellStore({
    theme: 'dark',
    desktop: createDesktop(
      [createWorkspace('Bench', grid(windows.map((window) => window.id)))],
      windows
    ),
  });
  await render(<App ports={robot.ports} robots={new RobotRegistry([])} store={store} synthetic />);
  robot.connect({ transport: 'websocket', url: 'ws://robot' });
  await expect.poll(() => robot.ports.connection.status()).toMatchObject({ phase: 'streaming' });
  await new Promise((resolve) => setTimeout(resolve, 1000));
  work.length = 0;

  await new Promise<void>((resolve) => {
    let last = performance.now();
    const until = last + RUN_MS;
    const frame = (now: number) => {
      intervals.push(now - last);
      last = now;

      if (now < until) {
        requestAnimationFrame(frame);
      } else {
        resolve();
      }
    };
    requestAnimationFrame(frame);
  });
  const stored = robot.store.variable('pose/linear_speed')?.storedSamples ?? 0;
  robot.disconnect();

  const fps =
    (1000 * intervals.length) / intervals.reduce((total, interval) => total + interval, 0);
  const summary = `${PLOTS} plots × 2 signals at 1 kHz: work p50 ${percentile(work, 0.5).toFixed(2)} ms, p95 ${percentile(work, 0.95).toFixed(2)} ms, max ${Math.max(...work).toFixed(2)} ms over ${work.length} frames; ${fps.toFixed(0)} fps, frame interval p95 ${percentile(intervals, 0.95).toFixed(1)} ms`;
  await annotate(summary);

  expect(document.querySelectorAll('[data-plot] canvas')).toHaveLength(PLOTS);
  expect(work.length).toBeGreaterThan(RUN_MS / 50);
  expect(stored).toBeGreaterThan(0.9 * (RUN_MS + 1000));
  expect(percentile(work, 0.95)).toBeLessThanOrEqual(8);
});
