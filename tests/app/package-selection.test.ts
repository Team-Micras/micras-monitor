import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { ReactNode } from 'react';

import { RobotRegistry } from '@/robot-kit';
import { mouse } from '@tests/support/robot-kit/packages';

import { createDemoRobot } from '@/app/fake/demo-robot';
import type { FakeRobot } from '@/app/fake/fake-robot';
import { PackageSelector } from '@/app/package-selection';
import { ManualScheduler } from '@/telemetry';

const URL = { transport: 'websocket', url: 'ws://robot' } as const;

function selectorFor(robot: FakeRobot, packages = [mouse({ id: 'micras' })]) {
  const registry = new RobotRegistry<ReactNode>(packages);
  return new PackageSelector(robot.ports.connection, robot.ports.schema, registry);
}

function demo(name: string | null = 'micras'): FakeRobot {
  return createDemoRobot({
    name,
    connectMs: 10,
    handshakeMs: 20,
    configureMs: 10,
    scheduler: new ManualScheduler(),
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('PackageSelector', () => {
  test('picks the package once the robot said who it is and the schema is known', () => {
    const robot = demo();
    const selector = selectorFor(robot);
    const changes = vi.fn<() => void>();
    selector.subscribe(changes);

    robot.connect(URL);
    vi.advanceTimersByTime(20);
    expect(robot.ports.connection.status()).toMatchObject({ kind: 'linked', phase: 'schema' });
    expect(selector.current()).toBeNull();

    vi.advanceTimersByTime(10);
    expect(robot.ports.connection.status()).toMatchObject({ phase: 'configuring' });
    expect(selector.current()?.package.id).toBe('micras');
    expect(changes).toHaveBeenCalledTimes(1);
  });

  test('keeps the same choice while the link reconfigures', () => {
    const robot = demo();
    const selector = selectorFor(robot);
    selector.subscribe(() => undefined);
    robot.connect(URL);
    vi.advanceTimersByTime(50);
    const chosen = selector.current();
    expect(chosen).not.toBeNull();

    robot.reconfigure();
    expect(robot.ports.connection.status()).toMatchObject({ phase: 'configuring' });
    expect(selector.current()).toBe(chosen);
    vi.advanceTimersByTime(20);
    expect(selector.current()).toBe(chosen);
  });

  test('lets go when the connection ends', () => {
    const robot = demo();
    const selector = selectorFor(robot);
    selector.subscribe(() => undefined);
    robot.connect(URL);
    vi.advanceTimersByTime(50);
    robot.disconnect();
    expect(selector.current()).toBeNull();
  });

  test('chooses raw mode for a robot no package matches', () => {
    const robot = demo('someone-else');
    const selector = selectorFor(robot);
    selector.subscribe(() => undefined);
    robot.connect(URL);
    vi.advanceTimersByTime(50);
    expect(robot.ports.connection.status()).toMatchObject({ kind: 'linked' });
    expect(selector.current()).toBeNull();
  });
});
