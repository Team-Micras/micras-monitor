import { afterEach, describe, expect, test } from 'vitest';

import { Monitor, type VariableDemand } from '@/core/monitor';
import type { WebSocketLike } from '@/sources/micras-comm/link';
import { MicrasCommSource, type MicrasCommOptions } from '@/sources/micras-comm/micras-comm-source';
import { StoredSchemaCache } from '@/sources/micras-comm/schema-storage';
import { HistoryStore } from '@/history';
import { MemoryStorage } from '@tests/support/app/layouts/memory-storage';
import {
  startInMemoryRobot,
  type InMemoryRobot,
} from '@tests/support/sources/micras-comm/in-memory-robot';
import { delay, TEST_TIMING, waitFor } from '@tests/support/sources/micras-comm/link-harness';
import { startSimulatedRobot, type SimulatedRobotOptions } from '@scripts/simulated-robot/server';
import { useVirtualTime } from '@tests/support/virtual-time';

const STOP = 5;
const LEAVE_ERROR = 6;
const NOT_IN_ERROR = 4;
const URL = { transport: 'websocket', url: 'ws://in-memory' } as const;
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
const PINNED: readonly VariableDemand[] = [
  { role: 'state', variable: 'state', rateHz: 10 },
  { role: 'link.credit', variable: 'link/credit', rateHz: 2 },
  { role: 'link.dropped', variable: 'link/dropped_samples', rateHz: 1 },
];

interface Setup {
  readonly sim: InMemoryRobot;
  readonly source: MicrasCommSource;
  readonly monitor: Monitor<HistoryStore>;
  readonly sockets: WebSocketLike[];
}

let running: Setup[] = [];

function monitorOver(source: MicrasCommSource): Monitor<HistoryStore> {
  return new Monitor({
    history: new HistoryStore({ scheduler: { schedule: (task) => setTimeout(task, 0) } }),
    source,
  });
}

function start(
  faults: Partial<Omit<SimulatedRobotOptions, 'port'>> = {},
  options: MicrasCommOptions = {}
): Setup {
  const sim = startInMemoryRobot(faults);
  const sockets: WebSocketLike[] = [];
  const source = new MicrasCommSource({
    timing: TEST_TIMING,
    planner: { debounceMs: 20 },
    createSocket: (url) => {
      const socket = sim.createSocket(url);
      sockets.push(socket);
      return socket;
    },
    ...options,
  });
  const monitor = monitorOver(source);
  const setup = { sim, source, monitor, sockets };
  running.push(setup);
  monitor.connect(URL);
  return setup;
}

function sessionState(source: MicrasCommSource): string | undefined {
  return source.session?.state.kind;
}

function pagedLoads(monitor: Monitor<HistoryStore>): number {
  return monitor.state.log.filter((entry) => entry.text.startsWith('loading a schema')).length;
}

async function streaming(source: MicrasCommSource, what = 'the link to stream'): Promise<void> {
  await waitFor(() => sessionState(source) === 'streaming', 5000, what);
}

function gauge(monitor: Monitor<HistoryStore>, label: string) {
  return monitor.state.stats.gauges.find((entry) => entry.label === label);
}

describe('MicrasCommSource against the simulated robot', () => {
  useVirtualTime();

  afterEach(() => {
    for (const { sim, monitor } of running) {
      monitor.disconnect();
      sim.close();
    }

    running = [];
  });

  test('connects, learns the schema and says who the robot is', async () => {
    const { monitor } = start();

    await waitFor(() => monitor.state.status.kind === 'linked', 5000, 'the link');

    const { status } = monitor.state;
    expect(status.kind === 'linked' && status.identity.name).toBe('micras');
    expect(status.kind === 'linked' && status.since).toBeGreaterThan(0);
    await waitFor(() => monitor.state.variables.length > 0, 2000, 'the schema');
    expect(monitor.state.variables.map((variable) => variable.name)).toContain('maze');
    expect(monitor.state.variables.find((v) => v.name === 'maze')?.tag).toBe('maze-grid');
    expect(monitor.state.identity).toBe(status.kind === 'linked' ? status.identity : null);
  });

  test('streams what is asked for into the history, and the planner owns the groups', async () => {
    const { source, monitor } = start();
    monitor.request([...PINNED, { variable: 'imu/gyro_z', rateHz: 50 }]);

    await streaming(source);
    await waitFor(() => monitor.history.latest('imu/gyro_z') !== undefined, 3000, 'a sample');

    const plan = source.planner?.plan;
    expect(plan?.rates.map((rate) => rate.variable)).toEqual([
      'state',
      'link/credit',
      'link/dropped_samples',
      'imu/gyro_z',
    ]);
    expect(plan?.overBudget).toBe(false);
    expect(monitor.history.timeRange('imu/gyro_z')).toBeDefined();
    await waitFor(() => monitor.state.stats.streams.length === 4, 2000, 'link stats');
    expect(gauge(monitor, 'Credit')?.capacity).toBe(256);
    expect(monitor.state.log.some((entry) => entry.text === 'streaming')).toBe(true);
  });

  test('keeps the variables of the robot while its link recovers', async () => {
    const { source, monitor, sockets } = start();
    await streaming(source);
    const { variables, identity } = monitor.state;

    sockets[0].close();
    await waitFor(() => sessionState(source) !== 'streaming', 2000, 'the drop');
    expect(monitor.state.variables).toBe(variables);
    await streaming(source, 'the link to stream again');

    expect(monitor.state.variables).toBe(variables);
    expect(monitor.state.identity?.name).toBe(identity?.name);
  });

  test('learns the schema from its pages once over its reconnections', async () => {
    const { source, monitor } = start();
    await streaming(source);
    monitor.disconnect();
    monitor.connect(URL);
    await streaming(source, 'the link to stream again');
    expect(pagedLoads(monitor)).toBe(1);
  });

  test('skips the paged schema on a later page load with a stored cache', async () => {
    const storage = new MemoryStorage();
    const before = start({}, { schemaCache: new StoredSchemaCache(storage) });
    await streaming(before.source);

    const reloaded = start({}, { schemaCache: new StoredSchemaCache(storage) });
    await streaming(reloaded.source);
    expect(pagedLoads(before.monitor)).toBe(1);
    expect(pagedLoads(reloaded.monitor)).toBe(0);
    expect(reloaded.monitor.state.variables).toEqual(before.monitor.state.variables);
  });

  test('plans every streamed variable when all are asked for at the loop rate', async () => {
    const { source, monitor } = start();
    await streaming(source);
    const streamed = monitor.state.variables.filter((entry) => entry.access.stream);
    monitor.request(streamed.map((entry) => ({ variable: entry.name, rateHz: 8000 })));

    await waitFor(
      () => source.planner?.plan?.rates.length === streamed.length,
      3000,
      'a plan of every streamed variable'
    );
    expect(source.planner?.plan?.rates.map((rate) => rate.variable).toSorted()).toEqual(
      streamed.map((entry) => entry.name).toSorted()
    );
    await waitFor(() => monitor.history.latest('imu/gyro_z') !== undefined, 3000, 'a sample');
  });

  test('reads a blob on demand into the latest values', async () => {
    const { source, monitor } = start();
    await streaming(source);

    const outcome = await monitor.read('maze');

    expect(outcome.status).toBe('ok');
    expect(monitor.history.latest('maze')?.value).toBeInstanceOf(Uint8Array);
    expect(await monitor.read('nothing')).toMatchObject({ status: 'failed' });
  });

  test('writes with the robot confirming or refusing, never assuming', async () => {
    const { source, monitor } = start();
    await streaming(source);

    const write = monitor.write('run_profile', 3);
    expect(monitor.pendingWrite('run_profile')).toBe(3);
    expect(await write).toEqual({ status: 'confirmed' });
    expect(monitor.pendingWrite('run_profile')).toBeUndefined();
    expect(await monitor.write('state', 1)).toEqual({ status: 'refused', reason: 'read-only' });
    expect(await monitor.write('ghost', 1)).toEqual({
      status: 'refused',
      reason: 'no-such-variable',
    });
  });

  test('sends STOP and maps refusals with their reason', async () => {
    const { monitor } = start();
    await waitFor(() => monitor.state.status.kind === 'linked', 5000, 'the link');

    expect(await monitor.command(STOP)).toEqual({ status: 'ok', reason: null });
    expect(await monitor.command(LEAVE_ERROR)).toEqual({
      status: 'refused',
      reason: NOT_IN_ERROR,
    });
  });

  test('takes a command in every phase of a link that is up', async () => {
    const { source, monitor } = start();
    await streaming(source);
    monitor.request([{ variable: 'imu/gyro_z', rateHz: 100 }]);
    await waitFor(() => sessionState(source) === 'configuring', 2000, 'a reconfiguration');

    expect(monitor.state.status.kind).toBe('linked');
    expect(await monitor.command(STOP)).toEqual({ status: 'ok', reason: null });
  });

  test('fails commands with no link instead of waiting', async () => {
    const monitor = monitorOver(new MicrasCommSource());

    expect(await monitor.command(STOP)).toMatchObject({ status: 'failed' });
    monitor.connect({ transport: 'websocket', url: 'http://nope' });
    expect(monitor.state.status).toMatchObject({ kind: 'failed' });
    monitor.connect({ transport: 'bluetooth' });
    expect(monitor.state.status).toMatchObject({ kind: 'failed' });
  });

  test('marks a reboot as a boundary and keeps the timeline going forward', async () => {
    const { source, monitor } = start({ rebootAfterSeconds: 1 });
    monitor.request([{ variable: 'imu/gyro_z', rateHz: 100 }]);
    await streaming(source);

    await waitFor(
      () => monitor.history.boundaries().some((boundary) => boundary.kind === 'reboot'),
      5000,
      'the reboot'
    );
    const reboot = monitor.history.boundaries().find((boundary) => boundary.kind === 'reboot');
    await streaming(source, 'streaming after the reboot');
    await waitFor(
      () => (monitor.history.latest('imu/gyro_z')?.timeUs ?? 0) > (reboot?.timeUs ?? Infinity),
      3000,
      'a sample after the reboot'
    );

    expect(monitor.state.log.some((entry) => entry.text === 'the robot rebooted')).toBe(true);
  });

  test('comes back on its own after the connection drops, across a boundary', async () => {
    const { source, monitor, sockets } = start();
    monitor.request([{ variable: 'imu/gyro_z', rateHz: 100 }]);
    await streaming(source);
    await waitFor(() => monitor.history.latest('imu/gyro_z') !== undefined, 3000, 'a sample');
    const before = monitor.history.latest('imu/gyro_z')?.timeUs ?? 0;

    sockets[0].close();

    await waitFor(() => sessionState(source) !== 'streaming', 3000, 'the drop');
    await streaming(source, 'streaming again');
    await waitFor(
      () => (monitor.history.latest('imu/gyro_z')?.timeUs ?? 0) > before,
      3000,
      'a sample after reconnecting'
    );

    expect(sockets.length).toBeGreaterThan(1);
    expect(monitor.history.boundaries().map((boundary) => boundary.kind)).toContain('reconnect');
  });

  test('notes in the log what goes wrong on the transport', async () => {
    const { source, monitor, sim } = start();
    await streaming(source);

    sim.close();

    await waitFor(
      () => monitor.state.log.some((entry) => entry.text === 'WebSocket error on ws://in-memory'),
      5000,
      'the transport error in the log'
    );
    expect(
      monitor.state.log.find((entry) => entry.text === 'WebSocket error on ws://in-memory')
    ).toMatchObject({ source: 'link', severity: 'warning' });
  });

  test('says another monitor took the link and does not take it back on its own', async () => {
    const { source, monitor, sim, sockets } = start();
    await streaming(source);

    sim.takeOver();
    await waitFor(() => monitor.state.status.kind === 'failed', 3000, 'the link to be taken');
    await delay(30_000);

    expect(monitor.state.status).toMatchObject({
      kind: 'failed',
      message: 'Another monitor took the link. Connect to take it back.',
    });
    expect(sockets).toHaveLength(1);
    expect(
      monitor.state.log.filter((entry) => entry.text === 'another monitor took the link')
    ).toMatchObject([{ source: 'link', severity: 'warning' }]);
  });

  test('keeps the samples lost on a noisy link as gaps with their count', async () => {
    const { source, monitor } = start({ corruptRate: 0.05, seed: 7 });
    monitor.request([{ variable: 'imu/gyro_z', rateHz: 200 }]);
    await streaming(source);
    await waitFor(
      () => (source.session?.stats.droppedSamples ?? 0) >= 20,
      10_000,
      'samples lost to corrupted frames'
    );
    const lost = source.session?.stats.droppedSamples;
    monitor.disconnect();

    const gaps = monitor.history.gaps('imu/gyro_z', 0, Number.POSITIVE_INFINITY);
    const dropped = gaps.filter((gap) => gap.kind === 'dropped');
    const counted = dropped.reduce((total, gap) => total + (gap.count ?? 0), 0);

    expect(dropped.length).toBeGreaterThan(0);
    expect(counted).toBe(monitor.history.variable('imu/gyro_z')?.droppedSamples);
    expect(counted).toBe(lost);
  });

  test('settles within a 3 KB/s link through several probes, then stops dropping', async () => {
    const { source, monitor, sim } = start(
      { throughputBytesPerSecond: 3000 },
      {
        timing: { ...TEST_TIMING, statsIntervalMs: 1000 },
        planner: { debounceMs: 20, budget: { holdMs: 2000, quietHolds: 30 } },
      }
    );
    monitor.request([
      ...PINNED,
      ...[...IMU, ...CONTROL].map((variable) => ({ variable, rateHz: 100 })),
    ]);
    await streaming(source);
    await waitFor(
      () => (source.planner?.budget.capacityBytesPerSecond ?? Infinity) < 3000 * 1.5,
      5000,
      'the first ceiling'
    );

    let overspent = false;
    const watch = setInterval(() => {
      const plan = source.planner?.plan;
      overspent ||= (plan?.usedBytesPerSecond ?? 0) > (plan?.budgetBytesPerSecond ?? 0);
    }, 50);
    await delay(16_000);
    const settled = { ...sim.stats };
    const settledMonitor = source.session?.stats;
    await delay(8000);
    clearInterval(watch);

    const { stats } = monitor.state;
    const plan = source.planner?.plan;
    const session = source.session?.stats;

    expect(plan?.overBudget).toBe(true);
    expect(((session?.bytesIn ?? 0) - (settledMonitor?.bytesIn ?? 0)) / 8).toBeLessThanOrEqual(
      3000
    );
    expect(overspent).toBe(false);
    expect(plan?.usedBytesPerSecond).toBeLessThanOrEqual(plan?.budgetBytesPerSecond ?? 0);
    expect(gauge(monitor, 'Budget')?.capacity).toBeGreaterThan(3000 * 0.75);
    expect(plan?.rates.find((rate) => rate.variable === 'state')?.grantedHz).toBeCloseTo(10);
    expect(sim.stats.radioOverflowBytes).toBe(0);
    expect(sim.stats.samplesDropped - settled.samplesDropped).toBe(0);
    expect((session?.droppedSamples ?? 0) - (settledMonitor?.droppedSamples ?? 0)).toBe(0);
    expect(stats.samplesDropped).toBe(session?.droppedSamples);
    expect(Math.abs(sim.stats.samplesDropped - (session?.droppedSamples ?? 0))).toBeLessThanOrEqual(
      4
    );
  });

  test('marks a boundary when a stalled link has to shake hands again', async () => {
    const { source, monitor } = start({ dropCredits: 40 });
    monitor.request([{ variable: 'imu/gyro_z', rateHz: 200 }]);
    await streaming(source);

    await waitFor(
      () => monitor.history.boundaries().some((boundary) => boundary.kind === 'reconnect'),
      8000,
      'a boundary for the stall'
    );

    expect(monitor.state.status.kind).not.toBe('failed');
  });
});

describe('MicrasCommSource over the WebSocket of the simulated robot', () => {
  test(
    'connects through the server and streams what is asked for',
    { timeout: 60_000 },
    async () => {
      const sim = await startSimulatedRobot({ port: 0 });
      const source = new MicrasCommSource({ timing: { ...TEST_TIMING, silenceTimeoutMs: 5000 } });
      const monitor = monitorOver(source);

      try {
        monitor.connect({ transport: 'websocket', url: `ws://127.0.0.1:${sim.port}` });
        monitor.request([{ variable: 'imu/gyro_z', rateHz: 50 }]);
        await waitFor(() => sessionState(source) === 'streaming', 30_000, 'the link to stream');
        await waitFor(() => monitor.history.latest('imu/gyro_z') !== undefined, 30_000, 'a sample');

        const { status } = monitor.state;
        expect(status.kind === 'linked' && status.identity.name).toBe('micras');
        expect(sim.stats.hellos).toBeGreaterThan(0);
      } finally {
        monitor.disconnect();
        await sim.close();
      }
    }
  );
});
