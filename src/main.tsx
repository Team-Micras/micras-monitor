import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from '@/app/app';
import { reservedChord } from '@/app/keymap/keymap';
import { safeLocalStorage } from '@/app/layouts/layout-book';
import type { AppMonitor } from '@/app/monitor-context';
import { serviceWorkerUpdates } from '@/app/pwa/app-updates';
import type { SessionManager } from '@/app/sessions/session-manager';
import { startStorageWorker } from '@/app/sessions/storage-worker';
import { PRELOAD_ERROR_EVENT } from '@/app/shell/update-notice';
import '@/app/styles.css';
import { Monitor } from '@/core/monitor';
import type { Source } from '@/core/source';
import { HistoryStore, type Scheduler } from '@/history';
import { importWhenIdle } from '@/lazy/idle';
import { RobotRegistry } from '@/robot-kit';
import type { BluetoothLike } from '@/sources/micras-comm/link';
import { MicrasCommSource } from '@/sources/micras-comm/micras-comm-source';
import { StoredSchemaCache } from '@/sources/micras-comm/schema-storage';
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

async function source(synthetic: boolean): Promise<Source> {
  if (synthetic) {
    const [{ DemoSource }, { DEMO_ROBOT }] = await Promise.all([
      import('@/sources/demo/demo-source'),
      import('@/sources/demo/demo-robot'),
    ]);
    return new DemoSource(DEMO_ROBOT);
  }

  return new MicrasCommSource({
    bluetooth: webBluetooth(),
    schemaCache: new StoredSchemaCache(safeLocalStorage()),
  });
}

const query = new URLSearchParams(location.search);
const synthetic = query.has('fake');
const connectTo = query.get('connect');
const viewCapBytes = memoryCap(query, 'view-cap-mb');
const monitor: AppMonitor = new Monitor({
  history: new HistoryStore({
    scheduler: FRAME_SCHEDULER,
    memoryCapBytes: memoryCap(query, 'memory-cap-mb'),
  }),
  source: await source(synthetic),
});

if (connectTo !== null) {
  monitor.connect({ transport: 'websocket', url: connectTo });
}

const storageWorker = startStorageWorker();
const robots = new RobotRegistry([micras], reservedChord);
const updates = import.meta.env.PROD ? serviceWorkerUpdates(registerSW) : undefined;
const reactRoot = createRoot(root);

function render(sessions?: SessionManager): void {
  reactRoot.render(
    <StrictMode>
      <App
        monitor={monitor}
        robots={robots}
        synthetic={synthetic}
        layouts={safeLocalStorage() ?? undefined}
        updates={updates}
        sessions={sessions}
      />
    </StrictMode>
  );
}

render();
importWhenIdle(
  () => import('@/app/sessions/browser-sessions'),
  ({ browserSessions }) =>
    render(browserSessions(monitor, FRAME_SCHEDULER, storageWorker, viewCapBytes)),
  () => window.dispatchEvent(new Event(PRELOAD_ERROR_EVENT))
);
