import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { ManualScheduler } from '@/telemetry';

import { subscribeThrottled } from '../monitor-context';
import { createDemoRobot } from './demo-robot';

const URL = { transport: 'websocket', url: 'ws://robot' } as const;
const STOP = 5;

function demo(scheduler = new ManualScheduler()) {
  return createDemoRobot({
    connectMs: 10,
    handshakeMs: 20,
    configureMs: 10,
    tickMs: 100,
    commandMs: 5,
    scheduler,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('FakeRobot', () => {
  test('goes through the statuses of a session', () => {
    const robot = demo();
    const kinds: string[] = [];
    robot.ports.connection.subscribe(() => {
      const status = robot.ports.connection.status();
      kinds.push(status.kind === 'linked' ? `linked:${status.phase}` : status.kind);
    });
    robot.connect(URL);
    vi.advanceTimersByTime(50);
    expect(kinds).toEqual([
      'connecting',
      'handshaking',
      'linked:schema',
      'linked:configuring',
      'linked:streaming',
    ]);
  });

  test('feeds a telemetry store the ports read from, by name or id', () => {
    const scheduler = new ManualScheduler();
    const robot = demo(scheduler);
    const heard = vi.fn<() => void>();
    robot.ports.values.subscribe(['battery_voltage'], heard);
    robot.connect(URL);
    vi.advanceTimersByTime(250);
    scheduler.flush();

    const latest = robot.ports.values.latest('battery_voltage');
    expect(typeof latest?.value).toBe('number');
    expect(latest?.timeUs).toBeGreaterThan(0);
    expect(heard).toHaveBeenCalled();
    const id = robot.ports.schema.variables().find((entry) => entry.name === 'maze')?.id ?? -1;
    expect(robot.ports.values.latest(id)?.value).toBeInstanceOf(Uint8Array);
    expect(robot.ports.values.latest('identification/valid')?.value).toBe(true);
  });

  test('takes commands in every phase of a link that is up, and none without one', async () => {
    const robot = demo();
    await expect(robot.ports.commands.send(STOP)).resolves.toMatchObject({ status: 'failed' });
    robot.connect(URL);
    vi.advanceTimersByTime(50);
    robot.reconfigure();
    const answer = robot.ports.commands.send(STOP);
    vi.advanceTimersByTime(5);
    await expect(answer).resolves.toEqual({ status: 'ok', reason: 0 });
    expect(robot.ports.connection.status()).toMatchObject({ phase: 'configuring' });
  });
});

describe('subscribeThrottled', () => {
  test('calls at most once per interval and delivers the last change at its end', () => {
    const scheduler = new ManualScheduler();
    const robot = demo(scheduler);
    const listener = vi.fn<() => void>();
    const stop = subscribeThrottled(robot.ports.values, 'battery_voltage', listener, 100);
    robot.connect(URL);
    vi.advanceTimersByTime(40);
    scheduler.flush();
    expect(listener).toHaveBeenCalledTimes(1);

    robot.store.setLatestValue(
      robot.ports.schema.variables().find((entry) => entry.name === 'battery_voltage')?.id ?? 0,
      1
    );
    scheduler.flush();
    expect(listener).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(100);
    expect(listener).toHaveBeenCalledTimes(2);
    stop();
  });
});
