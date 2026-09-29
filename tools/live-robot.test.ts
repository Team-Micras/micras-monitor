import { afterEach, describe, expect, test } from 'vitest';

import { LiveRobot, type LiveRobotOptions } from '../src/app/live/live-robot';
import type { StreamRequest } from '../src/app/ports';
import type { WebSocketLike } from '../src/link';
import { TEST_TIMING, waitFor } from './session-harness';
import {
  startSimulatedRobot,
  type SimulatedRobot,
  type SimulatedRobotOptions,
} from './simulated-robot/server';

const STOP = 5;
const LEAVE_ERROR = 6;
const NOT_IN_ERROR = 4;
const IMU = ['imu/gyro_x', 'imu/gyro_y', 'imu/gyro_z', 'imu/accel_x', 'imu/accel_y', 'imu/accel_z'];
const CONTROL = [
  'wall/0',
  'wall/1',
  'wall/2',
  'wall/3',
  'cmd/linear',
  'cmd/angular',
  'response/left',
  'response/right',
  'feed_forward/left',
  'feed_forward/right',
];
const PINNED: StreamRequest['pinned'] = [
  { role: 'state', variable: 'state', rateHz: 10 },
  { role: 'link.credit', variable: 'link/credit', rateHz: 2 },
  { role: 'link.dropped', variable: 'link/dropped_samples', rateHz: 1 },
];

interface Setup {
  readonly sim: SimulatedRobot;
  readonly live: LiveRobot;
  readonly sockets: WebSocketLike[];
}

let running: Setup[] = [];

afterEach(async () => {
  for (const { sim, live } of running) {
    live.disconnect();
    await sim.close();
  }

  running = [];
});

async function start(
  faults: Partial<SimulatedRobotOptions> = {},
  options: LiveRobotOptions = {}
): Promise<Setup> {
  const sim = await startSimulatedRobot({ ...faults, port: 0 });
  const sockets: WebSocketLike[] = [];
  const live = new LiveRobot({
    timing: TEST_TIMING,
    planner: { debounceMs: 20 },
    scheduler: { schedule: (task) => setTimeout(task, 0) },
    createSocket: (url) => {
      const socket = new WebSocket(url);
      sockets.push(socket);
      return socket;
    },
    ...options,
  });
  const setup = { sim, live, sockets };
  running.push(setup);
  live.connect({ transport: 'websocket', url: `ws://127.0.0.1:${sim.port}` });
  return setup;
}

function linkedPhase(live: LiveRobot): string | null {
  const status = live.ports.connection.status();
  return status.kind === 'linked' ? status.phase : null;
}

async function streaming(live: LiveRobot, what = 'the link to stream'): Promise<void> {
  await waitFor(() => linkedPhase(live) === 'streaming', 5000, what);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('LiveRobot against the simulated robot', () => {
  test('connects, learns the schema and says who the robot is', async () => {
    const { live } = await start();
    const statuses: string[] = [];
    live.ports.connection.subscribe(() => statuses.push(live.ports.connection.status().kind));

    await waitFor(() => live.ports.connection.status().kind === 'linked', 5000, 'the link');

    const status = live.ports.connection.status();
    expect(status.kind === 'linked' && status.robot.name).toBe('micras');
    expect(status.kind === 'linked' && status.since).toBeGreaterThan(0);
    await waitFor(() => live.ports.schema.variables().length > 0, 2000, 'the schema');
    expect(live.ports.schema.variables().map((variable) => variable.name)).toContain('maze');
    expect(live.ports.schema.variables().find((v) => v.name === 'maze')?.typeTag).not.toBeNull();
    expect(live.ports.connection.status()).toBe(live.ports.connection.status());
  });

  test('streams what is asked for into the store, and the planner owns the groups', async () => {
    const { live } = await start();
    live.ports.streams.request({
      windows: [{ variable: 'imu/gyro_z', rateHz: 50 }],
      pinned: PINNED,
    });

    await streaming(live);
    await waitFor(() => live.store.latest('imu/gyro_z') !== undefined, 3000, 'a sample');

    const plan = live.planner?.plan;
    expect(plan?.rates.map((rate) => rate.variable)).toEqual([
      'state',
      'link/credit',
      'link/dropped_samples',
      'imu/gyro_z',
    ]);
    expect(plan?.overBudget).toBe(false);
    expect(live.store.timeRange('imu/gyro_z')).toBeDefined();
    await waitFor(() => live.ports.link.stats().budget.planned.length === 4, 2000, 'link stats');
    expect(live.ports.link.stats().creditWindow).toBe(256);
    expect(live.ports.log.entries().some((entry) => entry.text === 'streaming')).toBe(true);
  });

  test('reads a blob on demand into the latest values', async () => {
    const { live } = await start();
    await streaming(live);

    const outcome = await live.ports.reads.read('maze');

    expect(outcome.status).toBe('ok');
    expect(live.store.latest('maze')?.value).toBeInstanceOf(Uint8Array);
    expect(await live.ports.reads.read('nothing')).toMatchObject({ status: 'failed' });
  });

  test('writes with the robot confirming or refusing, never assuming', async () => {
    const { live } = await start();
    await streaming(live);

    const write = live.ports.writes.write('run_profile', 3);
    expect(live.ports.writes.pending('run_profile')).toBe(3);
    expect(await write).toEqual({ status: 'confirmed' });
    expect(live.ports.writes.pending('run_profile')).toBeUndefined();
    expect(await live.ports.writes.write('state', 1)).toEqual({
      status: 'refused',
      reason: 'read-only',
    });
    expect(await live.ports.writes.write('ghost', 1)).toEqual({
      status: 'refused',
      reason: 'no-such-variable',
    });
  });

  test('sends STOP and maps refusals with their reason', async () => {
    const { live } = await start();
    await waitFor(() => live.ports.connection.status().kind === 'linked', 5000, 'the link');

    expect(await live.ports.commands.send(STOP)).toEqual({ status: 'ok', reason: null });
    expect(await live.ports.commands.send(LEAVE_ERROR)).toEqual({
      status: 'refused',
      reason: NOT_IN_ERROR,
    });
  });

  test('fails commands with no link instead of waiting', async () => {
    const live = new LiveRobot();

    expect(await live.ports.commands.send(STOP)).toMatchObject({ status: 'failed' });
    live.connect({ transport: 'websocket', url: 'http://nope' });
    expect(live.ports.connection.status()).toMatchObject({ kind: 'failed' });
    live.connect({ transport: 'bluetooth' });
    expect(live.ports.connection.status()).toMatchObject({ kind: 'failed' });
  });

  test('marks a reboot as a boundary and keeps the timeline going forward', async () => {
    const { live } = await start({ rebootAfterSeconds: 1 });
    live.ports.streams.request({ windows: [{ variable: 'imu/gyro_z', rateHz: 100 }], pinned: [] });
    await streaming(live);

    await waitFor(
      () => live.store.boundaries().some((boundary) => boundary.kind === 'reboot'),
      5000,
      'the reboot'
    );
    const reboot = live.store.boundaries().find((boundary) => boundary.kind === 'reboot');
    await streaming(live, 'streaming after the reboot');
    await waitFor(
      () => (live.store.latest('imu/gyro_z')?.timeUs ?? 0) > (reboot?.timeUs ?? Infinity),
      3000,
      'a sample after the reboot'
    );

    expect(live.ports.log.entries().some((entry) => entry.text === 'the robot rebooted')).toBe(
      true
    );
  });

  test('comes back on its own after the connection drops, across a boundary', async () => {
    const { live, sockets } = await start();
    live.ports.streams.request({ windows: [{ variable: 'imu/gyro_z', rateHz: 100 }], pinned: [] });
    await streaming(live);
    await waitFor(() => live.store.latest('imu/gyro_z') !== undefined, 3000, 'a sample');
    const before = live.store.latest('imu/gyro_z')?.timeUs ?? 0;

    sockets[0].close();

    await waitFor(() => linkedPhase(live) === null, 3000, 'the drop');
    await streaming(live, 'streaming again');
    await waitFor(
      () => (live.store.latest('imu/gyro_z')?.timeUs ?? 0) > before,
      3000,
      'a sample after reconnecting'
    );

    expect(sockets.length).toBeGreaterThan(1);
    expect(live.store.boundaries().map((boundary) => boundary.kind)).toContain('reconnect');
  });

  test(
    'settles within a 3 KB/s link through several probes, then stops dropping',
    { timeout: 45_000 },
    async () => {
      const { live, sim } = await start(
        { throughputBytesPerSecond: 3000 },
        {
          timing: { ...TEST_TIMING, statsIntervalMs: 1000 },
          planner: { debounceMs: 20, budget: { holdMs: 2000, quietHolds: 30 } },
        }
      );
      live.ports.streams.request({
        windows: [...IMU, ...CONTROL].map((variable) => ({ variable, rateHz: 100 })),
        pinned: PINNED,
      });
      await streaming(live);
      await waitFor(
        () => (live.planner?.budget.capacityBytesPerSecond ?? Infinity) < 3000 * 1.5,
        5000,
        'the first ceiling'
      );

      let overspent = false;
      const watch = setInterval(() => {
        const plan = live.planner?.plan;
        overspent ||= (plan?.usedBytesPerSecond ?? 0) > (plan?.budgetBytesPerSecond ?? 0);
      }, 50);
      await delay(16_000);
      const settled = { ...sim.stats };
      const settledMonitor = live.session?.stats;
      await delay(8000);
      clearInterval(watch);

      const stats = live.ports.link.stats();
      const plan = live.planner?.plan;
      const session = live.session?.stats;

      expect(plan?.overBudget).toBe(true);
      expect(((session?.bytesIn ?? 0) - (settledMonitor?.bytesIn ?? 0)) / 8).toBeLessThanOrEqual(
        3000
      );
      expect(overspent).toBe(false);
      expect(plan?.usedBytesPerSecond).toBeLessThanOrEqual(plan?.budgetBytesPerSecond ?? 0);
      expect(stats.budget.bytesPerSecond).toBeGreaterThan(3000 * 0.75);
      expect(plan?.rates.find((rate) => rate.variable === 'state')?.grantedHz).toBeCloseTo(10);
      expect(sim.stats.radioOverflowBytes).toBe(0);
      expect(sim.stats.samplesDropped - settled.samplesDropped).toBe(0);
      expect((session?.droppedSamples ?? 0) - (settledMonitor?.droppedSamples ?? 0)).toBe(0);
      expect(stats.samplesDropped).toBe(session?.droppedSamples);
      expect(
        Math.abs(sim.stats.samplesDropped - (session?.droppedSamples ?? 0))
      ).toBeLessThanOrEqual(4);
    }
  );

  test('marks a boundary when a stalled link has to shake hands again', async () => {
    const { live } = await start({ dropCredits: 40 });
    live.ports.streams.request({ windows: [{ variable: 'imu/gyro_z', rateHz: 200 }], pinned: [] });
    await streaming(live);

    await waitFor(
      () => live.store.boundaries().some((boundary) => boundary.kind === 'reconnect'),
      8000,
      'a boundary for the stall'
    );

    expect(live.ports.connection.status().kind).not.toBe('failed');
  });
});
