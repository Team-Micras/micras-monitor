import type { ReactNode } from 'react';
import { afterEach, expect, inject, test } from 'vitest';
import { render } from 'vitest-browser-react';

import { RobotRegistry, type RobotPackage } from '@/robot-kit';
import { mouse } from '@tests/support/robot-kit/packages';

import { App } from '@/app/app';
import type { AppMonitor } from '@/app/monitor-context';
import '@/app/styles.css';
import { createShellStore } from '@/app/state/shell-store';
import { Monitor } from '@/core/monitor';
import { MicrasCommSource } from '@/sources/micras-comm/micras-comm-source';
import { TelemetryStore } from '@/telemetry';

declare module 'vitest' {
  interface ProvidedContext {
    simulatedRobotPort: number;
  }
}

const MICRAS: RobotPackage<ReactNode> = mouse({ id: 'micras', displayName: 'Micras' });

let monitor: AppMonitor | undefined;

function liveMonitor(source: MicrasCommSource): AppMonitor {
  return new Monitor({
    history: new TelemetryStore({
      scheduler: { schedule: (task) => requestAnimationFrame(() => task()) },
    }),
    source,
  });
}

function readout(): string {
  return document.querySelector('[data-readout="imu/gyro_z"] dd')?.textContent ?? '';
}

afterEach(() => {
  monitor?.disconnect();
  monitor = undefined;
});

test('shows live values of the simulated robot over a WebSocket', async () => {
  const source = new MicrasCommSource({ planner: { debounceMs: 20 } });
  monitor = liveMonitor(source);
  const store = createShellStore({ theme: 'dark' });
  store.getState().openWindow('readouts', ['imu/gyro_z', 'state']);
  const screen = await render(
    <App monitor={monitor} robots={new RobotRegistry([MICRAS])} store={store} />
  );

  monitor.connect({
    transport: 'websocket',
    url: `ws://127.0.0.1:${inject('simulatedRobotPort')}`,
  });

  await expect.element(screen.getByText('· connected')).toBeVisible();
  await expect.poll(readout).toMatch(/^-?\d+\.\d{3}$/);
  const first = readout();
  await expect.poll(readout).not.toBe(first);
  expect(source.planner?.plan?.rates.map((rate) => rate.variable)).toContain('imu/gyro_z');
});

test('reads the blob of a type view once the schema of the simulated robot has it', async () => {
  monitor = liveMonitor(new MicrasCommSource({ planner: { debounceMs: 20 } }));
  const store = createShellStore({ theme: 'dark' });
  store.getState().openWindow('type-view', ['maze']);
  await render(<App monitor={monitor} robots={new RobotRegistry([MICRAS])} store={store} />);

  monitor.connect({
    transport: 'websocket',
    url: `ws://127.0.0.1:${inject('simulatedRobotPort')}`,
  });

  await expect.poll(() => document.querySelector('[data-hex-dump]') !== null).toBe(true);
});
