import { afterEach, describe, expect, test } from 'vitest';
import { render } from 'vitest-browser-react';

import { MonitorContext, type AppMonitor } from '@/ui/monitor-context';
import { useReloadBlocked } from '@/ui/shell/reload-guard';
import { DEMO_VARIABLES } from '@/sources/demo/demo-robot';
import { mouse } from '@tests/support/core/robot/packages';
import { DEMO_TARGET, demoMonitor, monitorScope } from '@tests/support/sources/demo-monitor';

const IDLE = 0;
const RUN = 1;
const monitors: AppMonitor[] = [];

afterEach(() => {
  monitors.splice(0).forEach((monitor) => monitor.disconnect());
});

function Probe() {
  return <output data-block>{useReloadBlocked() ?? 'free'}</output>;
}

interface Options {
  readonly state?: number;
  readonly withPackage?: boolean;
  readonly answerMs?: number;
}

async function open({ state, withPackage = true, answerMs = 5 }: Options) {
  const [first, ...others] = DEMO_VARIABLES;
  const variables = state === undefined ? others : [{ ...first, signal: () => state }, ...others];
  const monitor = demoMonitor({ answerMs, sampleRateHz: 50, robot: { variables } });
  monitors.push(monitor);
  const screen = await render(
    <MonitorContext value={monitorScope(monitor, withPackage ? [mouse({ id: 'micras' })] : [])}>
      <Probe />
    </MonitorContext>
  );
  return { monitor, screen };
}

describe('useReloadBlocked', () => {
  test('is free while nothing is connected', async () => {
    const { screen } = await open({ state: IDLE });

    await expect.element(screen.getByText('free')).toBeVisible();
  });

  test('is free once a linked robot is idle', async () => {
    const { monitor, screen } = await open({ state: IDLE });
    monitor.connect(DEMO_TARGET);

    await expect.poll(() => monitor.state.status.kind).toBe('linked');
    await expect.element(screen.getByText('free')).toBeVisible();
  });

  test('holds back a linked robot that runs', async () => {
    const { monitor, screen } = await open({ state: RUN });
    monitor.connect(DEMO_TARGET);

    await expect.element(screen.getByText('not-idle')).toBeVisible();
  });

  test('holds back a linked robot whose state has no value', async () => {
    const { monitor, screen } = await open({});
    monitor.connect(DEMO_TARGET);

    await expect.poll(() => monitor.state.status.kind).toBe('linked');
    await expect.element(screen.getByText('not-idle')).toBeVisible();
  });

  test('asks a robot with no package to disconnect', async () => {
    const { monitor, screen } = await open({ state: IDLE, withPackage: false });
    monitor.connect(DEMO_TARGET);

    await expect.element(screen.getByText('disconnect')).toBeVisible();
  });

  test('holds back the reload while the link connects', async () => {
    const { monitor, screen } = await open({ state: IDLE, answerMs: 60_000 });
    monitor.connect(DEMO_TARGET);

    await expect.poll(() => monitor.state.status.kind).toBe('connecting');
    await expect.element(screen.getByText('disconnect')).toBeVisible();
  });

  test('is free again after disconnecting on purpose from a run', async () => {
    const { monitor, screen } = await open({ state: RUN });
    monitor.connect(DEMO_TARGET);
    await expect.element(screen.getByText('not-idle')).toBeVisible();

    monitor.disconnect();

    await expect.element(screen.getByText('free')).toBeVisible();
  });
});
