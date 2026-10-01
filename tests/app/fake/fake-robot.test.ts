import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { subscribeThrottled } from '@/app/monitor-context';
import { createDemoRobot } from '@/app/fake/demo-robot';
import { FakeRobot } from '@/app/fake/fake-robot';
import { ManualScheduler } from '@/telemetry';

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

describe('FakeRobot sampling', () => {
  const TICK_MS = 100;

  function sampler(now?: () => number) {
    const robot = new FakeRobot({
      name: 'sampler',
      schemaHash: 1,
      variables: [
        {
          name: 'x',
          type: 'f32',
          access: { stream: true, write: false, writeNeedsIdle: false, persists: false },
        },
      ],
      connectMs: 10,
      handshakeMs: 20,
      configureMs: 10,
      tickMs: TICK_MS,
      scheduler: new ManualScheduler(),
      now,
    });
    robot.connect(URL);
    vi.advanceTimersByTime(40);
    expect(robot.ports.connection.status()).toMatchObject({ phase: 'streaming' });
    return { robot, stored: () => robot.store.variable('x')?.storedSamples ?? 0 };
  }

  test('keeps sampling when the wall clock steps back', () => {
    const { stored } = sampler();
    const before = stored();
    vi.setSystemTime(Date.now() - 60_000);
    vi.advanceTimersByTime(10 * TICK_MS);
    expect(stored() - before).toBe(10);
  });

  test('catches up on the samples due since a late tick', () => {
    let now = 1000;
    const { stored } = sampler(() => now);
    const before = stored();
    now += 3000;
    vi.advanceTimersByTime(TICK_MS);
    expect(stored() - before).toBe(3000 / TICK_MS);
  });

  test('catches up on at most the last 10 s after a long stall', () => {
    let now = 1000;
    const { stored } = sampler(() => now);
    const before = stored();
    now += 60_000;
    vi.advanceTimersByTime(TICK_MS);
    expect(stored() - before).toBe(10_000 / TICK_MS + 1);
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
