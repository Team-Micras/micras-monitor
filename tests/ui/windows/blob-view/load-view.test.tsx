import type { ReactNode } from 'react';
import { afterEach, describe, expect, test } from 'vitest';
import { render } from 'vitest-browser-react';

import { RobotRegistry, type BlobView, type SerializableType } from '@/core/robot';
import { createDesktop, createWorkspace, leaf } from '@/tiling';
import { mouse } from '@tests/support/core/robot/packages';
import { DEMO_TARGET, demoMonitor } from '@tests/support/sources/demo-monitor';

import { App } from '@/ui/app';
import type { AppMonitor } from '@/ui/monitor-context';
import { createShellStore } from '@/ui/state/shell-store';
import '@/ui/styles.css';

const MAZE_TAG = 'maze-grid';
const monitors: AppMonitor[] = [];

afterEach(() => {
  monitors.splice(0).forEach((monitor) => monitor.disconnect());
});

const drawn: BlobView<unknown, string> = ({ value }) => `drawn ${String(value)} bytes`;

function loadedType(
  loadView: () => Promise<BlobView<unknown, string>>
): SerializableType<unknown, string> {
  return {
    kind: 'serializable',
    tag: MAZE_TAG,
    name: 'Grid',
    decode: (bytes) => bytes.length,
    loadView,
  };
}

async function mount(type: SerializableType<unknown, string>, windowKind: string) {
  const monitor = demoMonitor();
  monitors.push(monitor);
  const robots = new RobotRegistry<ReactNode>([
    mouse({ id: 'micras', displayName: 'Micras', types: [type], variables: {} }),
  ]);
  const store = createShellStore({
    theme: 'dark',
    desktop: createDesktop(
      [createWorkspace('Test', leaf('only'))],
      [{ id: 'only', kind: windowKind, payload: { variables: ['maze'] } }]
    ),
  });
  const screen = await render(<App monitor={monitor} robots={robots} store={store} synthetic />);
  return { monitor, screen };
}

describe('a view a package loads with loadView', () => {
  test('says its window failed when the chunk fails, and draws on Retry once it loads', async () => {
    let broken = true;
    let loads = 0;
    const { monitor, screen } = await mount(
      loadedType(() => {
        loads += 1;
        return broken
          ? Promise.reject(new Error('Failed to fetch dynamically imported module'))
          : Promise.resolve(drawn);
      }),
      'blob-view'
    );
    monitor.connect(DEMO_TARGET);

    const failed = screen.getByRole('region', { name: 'Window failed to load' });
    await expect.element(failed).toBeVisible();
    const before = loads;

    broken = false;
    await failed.getByRole('button', { name: 'Retry' }).click();
    await expect.element(screen.getByText(/^drawn \d+ bytes$/)).toBeVisible();
    await expect.element(failed).not.toBeInTheDocument();
    expect(loads).toBeGreaterThan(before);
  });

  test('is loaded by the idle prefetch before any window draws it', async () => {
    let loads = 0;
    await mount(
      loadedType(() => {
        loads += 1;
        return Promise.resolve(drawn);
      }),
      'log'
    );

    await expect.poll(() => loads, { timeout: 5000 }).toBeGreaterThan(0);
  });
});
