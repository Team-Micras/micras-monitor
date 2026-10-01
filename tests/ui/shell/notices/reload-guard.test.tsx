import { afterEach, describe, expect, test } from 'vitest';
import { render } from 'vitest-browser-react';

import { MonitorContext, type AppMonitor } from '@/ui/monitor-context';
import { reloadBlock, useReloadBlocked, type ReloadFacts } from '@/ui/shell/notices/reload-guard';
import { DEMO_VARIABLES } from '@/sources/demo/demo-robot';
import { mouse } from '@tests/support/core/robot/packages';
import { DEMO_TARGET, demoMonitor, monitorScope } from '@tests/support/sources/demo-monitor';

const linkedIdle: ReloadFacts = { link: 'linked', idle: true, hasPackage: true, lastIdle: true };

describe('reloadBlock', () => {
  test('lets a linked robot at rest reload', () => {
    expect(reloadBlock(linkedIdle)).toBeNull();
  });

  test('holds back a linked robot that runs, or whose state is unknown', () => {
    expect(reloadBlock({ ...linkedIdle, idle: false, lastIdle: false })).toBe('not-idle');
    expect(reloadBlock({ ...linkedIdle, idle: null, lastIdle: null })).toBe('not-idle');
  });

  test('asks a linked robot with no package to disconnect first', () => {
    expect(reloadBlock({ ...linkedIdle, hasPackage: false, idle: null })).toBe('disconnect');
  });

  test.each(['connecting', 'handshaking'] as const)(
    'holds back the reload while the link is %s, whatever the state was',
    (link) => {
      expect(reloadBlock({ ...linkedIdle, link, idle: null, lastIdle: false })).toBe('not-idle');
      expect(reloadBlock({ ...linkedIdle, link, idle: null, lastIdle: true })).toBe('disconnect');
      expect(reloadBlock({ ...linkedIdle, link, idle: null, lastIdle: null })).toBe('disconnect');
    }
  );

  test('asks to disconnect after a drop from a state that was not idle', () => {
    expect(reloadBlock({ ...linkedIdle, link: 'failed', idle: null, lastIdle: false })).toBe(
      'disconnect'
    );
    expect(reloadBlock({ ...linkedIdle, link: 'failed', idle: null, lastIdle: true })).toBeNull();
    expect(reloadBlock({ ...linkedIdle, link: 'failed', idle: null, lastIdle: null })).toBeNull();
  });

  test('holds back the reload while recording, whatever the robot does', () => {
    expect(reloadBlock({ ...linkedIdle, recording: true })).toBe('recording');
    expect(
      reloadBlock({
        link: 'disconnected',
        idle: null,
        hasPackage: false,
        lastIdle: null,
        recording: true,
      })
    ).toBe('recording');
    expect(reloadBlock({ ...linkedIdle, recording: false })).toBeNull();
  });

  test('lets the user reload after disconnecting on purpose', () => {
    expect(
      reloadBlock({ ...linkedIdle, link: 'disconnected', idle: null, lastIdle: null })
    ).toBeNull();
  });
});

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
