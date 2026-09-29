import type { ReactNode } from 'react';
import { afterEach, expect, inject, test } from 'vitest';
import { render } from 'vitest-browser-react';

import { RobotRegistry, type RobotPackage } from '@/robot-kit';
import { mouse } from '@/robot-kit/fixtures/packages';

import { App } from '../app';
import '../styles.css';
import { createShellStore } from '../state/shell-store';
import { LiveRobot } from './live-robot';

declare module 'vitest' {
  interface ProvidedContext {
    simulatedRobotPort: number;
  }
}

const MICRAS: RobotPackage<ReactNode> = mouse({ id: 'micras', displayName: 'Micras' });

let robot: LiveRobot | undefined;

afterEach(() => {
  robot?.disconnect();
  robot = undefined;
});

test('shows live values of the simulated robot over a WebSocket', async () => {
  robot = new LiveRobot({ planner: { debounceMs: 20 } });
  const store = createShellStore({ theme: 'dark' });
  store.getState().openWindow('readouts', ['imu/gyro_z', 'state']);
  const screen = await render(
    <App ports={robot.ports} robots={new RobotRegistry([MICRAS])} store={store} />
  );

  robot.connect({ transport: 'websocket', url: `ws://127.0.0.1:${inject('simulatedRobotPort')}` });

  await expect.element(screen.getByText('· connected')).toBeVisible();
  const row = screen.getByRole('listitem').filter({ hasText: 'imu/gyro_z' });
  await expect.element(row).toHaveTextContent(/imu\/gyro_z-?\d+\.\d{3}/);
  const first = row.element().textContent;
  await expect.poll(() => row.element().textContent, { timeout: 3000 }).not.toBe(first);
  expect(robot.planner?.plan?.rates.map((rate) => rate.variable)).toContain('imu/gyro_z');
});
