import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from '@/app/app';
import { safeLocalStorage } from '@/app/layouts/layout-book';
import { LiveRobot } from '@/app/live/live-robot';
import type { MonitorPorts } from '@/app/ports';
import { serviceWorkerUpdates } from '@/app/pwa/app-updates';
import { browserSessions } from '@/app/sessions/browser-sessions';
import '@/app/styles.css';
import type { BluetoothLike } from '@/link';
import { RobotRegistry } from '@/robot-kit';
import type { Scheduler, TelemetryStore } from '@/telemetry';
import { micras } from '@robots/micras';
import { registerSW } from 'virtual:pwa-register';

const root = document.getElementById('root');

if (!root) {
  throw new Error('index.html has no #root element to mount the monitor in');
}

const FRAME_SCHEDULER: Scheduler = {
  schedule: (task) => requestAnimationFrame(() => task()),
};

function isBluetooth(value: unknown): value is BluetoothLike {
  return typeof value === 'object' && value !== null && 'requestDevice' in value;
}

function webBluetooth(): BluetoothLike | undefined {
  const bluetooth: unknown = Reflect.get(navigator, 'bluetooth');
  return isBluetooth(bluetooth) ? bluetooth : undefined;
}

function memoryCap(query: URLSearchParams, name: string): number | undefined {
  const megabytes = Number(query.get(name) ?? Number.NaN);
  return Number.isFinite(megabytes) && megabytes > 0 ? megabytes * 1024 * 1024 : undefined;
}

function liveRobot(connectTo: string | null, memoryCapBytes: number | undefined): LiveRobot {
  const robot = new LiveRobot({
    scheduler: FRAME_SCHEDULER,
    bluetooth: webBluetooth(),
    memoryCapBytes,
  });

  if (connectTo !== null) {
    robot.connect({ transport: 'websocket', url: connectTo });
  }

  return robot;
}

const query = new URLSearchParams(location.search);
const synthetic = query.has('fake');
const memoryCapBytes = memoryCap(query, 'memory-cap-mb');
const viewCapBytes = memoryCap(query, 'view-cap-mb');
const robot: { readonly ports: MonitorPorts; readonly store: TelemetryStore } = synthetic
  ? (await import('@/app/fake/demo-robot')).createDemoRobot()
  : liveRobot(query.get('connect'), memoryCapBytes);
const { ports } = robot;
const sessions = browserSessions(robot.store, ports, FRAME_SCHEDULER, viewCapBytes);
const robots = new RobotRegistry([micras]);
const updates = import.meta.env.PROD ? serviceWorkerUpdates(registerSW) : undefined;

createRoot(root).render(
  <StrictMode>
    <App
      ports={ports}
      robots={robots}
      synthetic={synthetic}
      layouts={safeLocalStorage() ?? undefined}
      updates={updates}
      sessions={sessions}
    />
  </StrictMode>
);
