import type { ReactNode } from 'react';
import { afterEach, describe, expect, test } from 'vitest';
import { render } from 'vitest-browser-react';

import { RobotRegistry } from '@/robot-kit';
import { mouse } from '@tests/support/robot-kit/packages';

import { DEMO_VARIABLES, createDemoRobot } from '@/app/fake/demo-robot';
import type { FakeRobot } from '@/app/fake/fake-robot';
import { MonitorContext } from '@/app/monitor-context';
import { PackageSelector } from '@/app/package-selection';
import { useReloadBlocked } from '@/app/shell/reload-guard';

const IDLE = 0;
const RUN = 1;
const robots: FakeRobot[] = [];

afterEach(() => {
  robots.splice(0).forEach((robot) => robot.disconnect());
});

function Probe() {
  return <output data-block>{useReloadBlocked() ?? 'free'}</output>;
}

interface Options {
  readonly state?: number;
  readonly withPackage?: boolean;
  readonly handshakeMs?: number;
}

async function open({ state, withPackage = true, handshakeMs = 10 }: Options) {
  const [first, ...others] = DEMO_VARIABLES;
  const variables = state === undefined ? others : [{ ...first, signal: () => state }, ...others];
  const robot = createDemoRobot({
    connectMs: 5,
    handshakeMs,
    configureMs: 5,
    tickMs: 20,
    variables,
  });
  robots.push(robot);
  const registry = new RobotRegistry<ReactNode>(withPackage ? [mouse({ id: 'micras' })] : []);
  const selection = new PackageSelector(robot.ports.connection, robot.ports.schema, registry);
  const screen = await render(
    <MonitorContext value={{ ports: robot.ports, robots: registry, selection, synthetic: true }}>
      <Probe />
    </MonitorContext>
  );
  return { robot, screen };
}

describe('useReloadBlocked', () => {
  test('is free while nothing is connected', async () => {
    const { screen } = await open({ state: IDLE });

    await expect.element(screen.getByText('free')).toBeVisible();
  });

  test('is free once a linked robot is idle', async () => {
    const { robot, screen } = await open({ state: IDLE });
    robot.connect({ transport: 'websocket', url: 'ws://robot' });

    await expect.poll(() => robot.ports.connection.status().kind).toBe('linked');
    await expect.element(screen.getByText('free')).toBeVisible();
  });

  test('holds back a linked robot that runs', async () => {
    const { robot, screen } = await open({ state: RUN });
    robot.connect({ transport: 'websocket', url: 'ws://robot' });

    await expect.element(screen.getByText('not-idle')).toBeVisible();
  });

  test('holds back a linked robot whose state has no value', async () => {
    const { robot, screen } = await open({});
    robot.connect({ transport: 'websocket', url: 'ws://robot' });

    await expect.poll(() => robot.ports.connection.status().kind).toBe('linked');
    await expect.element(screen.getByText('not-idle')).toBeVisible();
  });

  test('asks a robot with no package to disconnect', async () => {
    const { robot, screen } = await open({ state: IDLE, withPackage: false });
    robot.connect({ transport: 'websocket', url: 'ws://robot' });

    await expect.element(screen.getByText('disconnect')).toBeVisible();
  });

  test('holds back the reload while the link connects', async () => {
    const { robot, screen } = await open({ state: IDLE, handshakeMs: 60_000 });
    robot.connect({ transport: 'websocket', url: 'ws://robot' });

    await expect.poll(() => robot.ports.connection.status().kind).toBe('handshaking');
    await expect.element(screen.getByText('disconnect')).toBeVisible();
  });

  test('is free again after disconnecting on purpose from a run', async () => {
    const { robot, screen } = await open({ state: RUN });
    robot.connect({ transport: 'websocket', url: 'ws://robot' });
    await expect.element(screen.getByText('not-idle')).toBeVisible();

    robot.disconnect();

    await expect.element(screen.getByText('free')).toBeVisible();
  });
});
