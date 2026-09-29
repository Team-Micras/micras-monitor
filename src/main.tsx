import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from '@/app/app';
import { safeLocalStorage } from '@/app/layouts/layout-book';
import { LiveRobot } from '@/app/live/live-robot';
import type { MonitorPorts } from '@/app/ports';
import { serviceWorkerUpdates } from '@/app/pwa/app-updates';
import '@/app/styles.css';
import type { BluetoothLike } from '@/link';
import { RobotRegistry } from '@/robot-kit';
import type { Scheduler } from '@/telemetry';
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

function liveRobot(connectTo: string | null): MonitorPorts {
  const robot = new LiveRobot({ scheduler: FRAME_SCHEDULER, bluetooth: webBluetooth() });

  if (connectTo !== null) {
    robot.connect({ transport: 'websocket', url: connectTo });
  }

  return robot.ports;
}

const query = new URLSearchParams(location.search);
const synthetic = query.has('fake');
const ports = synthetic
  ? (await import('@/app/fake/demo-robot')).createDemoRobot().ports
  : liveRobot(query.get('connect'));
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
    />
  </StrictMode>
);
