import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { Monitor } from '@/core/monitor';
import { DEMO_ROBOT } from '@/sources/demo/demo-robot';
import { DemoSource, type DemoOptions, type DemoRobot } from '@/sources/demo/demo-source';
import { ManualScheduler, TelemetryStore } from '@/history';

const URL = { transport: 'websocket', url: 'ws://robot' } as const;
const STOP = 5;
const EXPLORE = 0;

function demo(robot: DemoRobot = DEMO_ROBOT, options: DemoOptions = { answerMs: 10 }) {
  const scheduler = new ManualScheduler();
  const monitor = new Monitor({
    history: new TelemetryStore({ scheduler }),
    source: new DemoSource(robot, options),
  });
  return { monitor, scheduler };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('DemoSource', () => {
  test('answers once, as the robot it stands for, with no handshake to imitate', () => {
    const { monitor } = demo();
    const kinds: string[] = [];
    monitor.subscribe(() => kinds.push(monitor.state.status.kind));
    monitor.connect(URL);
    vi.advanceTimersByTime(50);

    expect([...new Set(kinds)]).toEqual(['connecting', 'linked']);
    expect(monitor.state.identity).toEqual({ name: 'micras', schema: '3f9a1c07' });
    expect(monitor.state.variables).toHaveLength(DEMO_ROBOT.variables.length);
  });

  test('reports its counters once instead of with every sample', () => {
    const { monitor } = demo();
    monitor.connect(URL);
    vi.advanceTimersByTime(50);
    const first = monitor.state.stats;
    vi.advanceTimersByTime(1000);

    expect(first.streams.length).toBeGreaterThan(0);
    expect(monitor.state.stats).toBe(first);
  });

  test('feeds the history the windows read, by name or id', () => {
    const { monitor, scheduler } = demo();
    const heard = vi.fn<() => void>();
    monitor.history.subscribe(['battery_voltage'], heard);
    monitor.connect(URL);
    vi.advanceTimersByTime(250);
    scheduler.flush();

    const latest = monitor.history.latest('battery_voltage');
    expect(typeof latest?.value).toBe('number');
    expect(heard).toHaveBeenCalled();
    const id = monitor.state.variables.find((entry) => entry.name === 'maze')?.id ?? -1;
    expect(monitor.history.latest(id)?.value).toBeInstanceOf(Uint8Array);
    expect(monitor.history.latest('identification/valid')?.value).toBe(true);
  });

  test('takes commands once it answered, refuses them while it runs, and none without a link', async () => {
    const { monitor } = demo();
    await expect(monitor.command(STOP)).resolves.toMatchObject({ status: 'failed' });
    monitor.connect(URL);
    vi.advanceTimersByTime(20);

    const explore = monitor.command(EXPLORE);
    vi.advanceTimersByTime(10);
    await expect(explore).resolves.toEqual({ status: 'refused', reason: 1 });

    const stop = monitor.command(STOP);
    vi.advanceTimersByTime(10);
    await expect(stop).resolves.toEqual({ status: 'ok', reason: 0 });
    expect(monitor.state.log.some((entry) => entry.text.startsWith('STOP: braking'))).toBe(true);
  });

  test('keeps a write pending until it answers, then holds the value', async () => {
    const { monitor } = demo();
    monitor.connect(URL);
    vi.advanceTimersByTime(20);

    const write = monitor.write('run_profile', 3);
    expect(monitor.pendingWrite('run_profile')).toBe(3);
    vi.advanceTimersByTime(10);

    await expect(write).resolves.toEqual({ status: 'confirmed' });
    expect(monitor.pendingWrite('run_profile')).toBeUndefined();
  });

  test('answers what is still waiting when the connection closes', async () => {
    const { monitor } = demo();
    monitor.connect(URL);
    vi.advanceTimersByTime(20);
    const read = monitor.read('maze');

    monitor.disconnect();

    await expect(read).resolves.toMatchObject({ status: 'failed' });
  });
});

describe('DemoSource sampling', () => {
  const RATE_HZ = 10;
  const TICK_MS = 1000 / RATE_HZ;

  function sampler(now?: () => number) {
    const { monitor } = demo(
      {
        name: 'sampler',
        schema: '00000001',
        variables: [
          {
            name: 'x',
            type: 'f32',
            access: { stream: true, write: false, writeNeedsIdle: false, persists: false },
          },
        ],
      },
      { answerMs: 10, sampleRateHz: RATE_HZ, now }
    );
    monitor.connect(URL);
    vi.advanceTimersByTime(40);
    expect(monitor.state.status.kind).toBe('linked');
    return () => monitor.history.variable('x')?.storedSamples ?? 0;
  }

  test('keeps sampling when the wall clock steps back', () => {
    const stored = sampler();
    const before = stored();
    vi.setSystemTime(Date.now() - 60_000);
    vi.advanceTimersByTime(10 * TICK_MS);
    expect(stored() - before).toBe(10);
  });

  test('catches up on the samples due since a late tick', () => {
    let now = 1000;
    const stored = sampler(() => now);
    const before = stored();
    now += 3000;
    vi.advanceTimersByTime(TICK_MS);
    expect(stored() - before).toBe(3000 / TICK_MS);
  });

  test('catches up on at most the last 10 s after a long stall', () => {
    let now = 1000;
    const stored = sampler(() => now);
    const before = stored();
    now += 60_000;
    vi.advanceTimersByTime(TICK_MS);
    expect(stored() - before).toBe(10_000 / TICK_MS + 1);
  });
});
