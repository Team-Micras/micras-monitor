import { describe, expect, test, vi } from 'vitest';

import { Monitor } from '@/core/monitor';
import type { SourceStats } from '@/core/source';
import type { Variable } from '@/core/variables';
import { ManualScheduler, HistoryStore } from '@/history';
import { ScriptedSource } from '@tests/support/sources/scripted-source';

const URL = { transport: 'websocket', url: 'ws://robot' } as const;
const ACCESS = { stream: true, write: true, writeNeedsIdle: false, persists: false };
const VARIABLES: readonly Variable[] = [
  { id: 0, name: 'state', type: 'u8', access: ACCESS },
  { id: 1, name: 'speed', type: 'f32', access: ACCESS },
  { id: 2, name: 'maze', type: 'bytes', access: { ...ACCESS, stream: false } },
];
const IDENTITY = { name: 'micras', schema: '0000abcd' };

function setup() {
  let hostMs = 0;
  const source = new ScriptedSource();
  const monitor = new Monitor({
    history: new HistoryStore({ scheduler: new ManualScheduler() }),
    source,
    now: () => hostMs,
  });
  monitor.connect(URL);
  const link = source.last;
  link.sink.status({ kind: 'linked', target: URL, identity: IDENTITY, since: 1 });
  link.sink.variables(VARIABLES);
  return {
    source,
    monitor,
    link,
    advance: (ms: number) => {
      hostMs += ms;
    },
  };
}

describe('Monitor fed by a source', () => {
  test('keeps the status, who the robot is and its variables, as stable snapshots', () => {
    const { monitor } = setup();
    const { state } = monitor;

    expect(state.status).toMatchObject({ kind: 'linked', identity: IDENTITY });
    expect(state.identity).toBe(IDENTITY);
    expect(state.variables).toBe(VARIABLES);
    expect(monitor.state).toBe(state);
    expect(monitor.history.variable('speed')?.type).toBe('f32');
  });

  test('stores the samples of a stream on the session timeline, with the ones lost before them', () => {
    const { monitor, link } = setup();
    link.sink.streamOpened({ id: 7, slot: 0, variableIds: [0, 1], clock: 3 });
    link.sink.sample(7, 1_000_000, [1, 0.5], 0);
    link.sink.sample(7, 1_001_000, [1, 0.6], 0);
    link.sink.sample(7, 1_005_000, [1, 0.7], 3);

    expect(monitor.history.latest('speed')).toEqual({ value: 0.7, timeUs: 1_005_000 });
    expect(monitor.history.variable('speed')).toMatchObject({
      storedSamples: 3,
      droppedSamples: 3,
    });
    expect(monitor.history.gaps('speed', 0, 2_000_000)).toEqual([
      { kind: 'dropped', startUs: 1_001_000, endUs: 1_005_000, count: 3 },
    ]);
  });

  test('ignores samples of a stream it does not know or that has a variable it does not', () => {
    const { monitor, link } = setup();
    link.sink.streamOpened({ id: 1, slot: 0, variableIds: [0, 9], clock: 0 });
    link.sink.sample(1, 0, [1, 2], 0);
    link.sink.sample(2, 0, [1], 0);

    expect(monitor.history.latest('state')).toBeUndefined();
  });

  test('logs a warning for a stream that names variables the robot does not have', () => {
    const { monitor, link } = setup();
    link.sink.streamOpened({ id: 1, slot: 0, variableIds: [0, 9], clock: 0 });

    expect(monitor.state.log.at(-1)).toMatchObject({
      severity: 'warning',
      source: 'link',
      text: expect.stringContaining('(9)'),
    });
  });

  test('stops mapping a stream the history closed to open another over the same variable', () => {
    const { monitor, link } = setup();
    link.sink.streamOpened({ id: 1, slot: 0, variableIds: [0, 1], clock: 0 });
    link.sink.streamOpened({ id: 2, slot: 1, variableIds: [1], clock: 0 });

    expect(() => link.sink.sample(1, 1_000, [1, 0.5], 0)).not.toThrow();
    link.sink.sample(2, 2_000, [0.7], 0);
    expect(monitor.history.latest('speed')?.value).toBe(0.7);
  });

  test('takes values that come outside a stream, such as read answers', () => {
    const { monitor, link } = setup();
    link.sink.value(2, new Uint8Array([1, 2]));

    expect(monitor.history.latest('maze')?.value).toEqual(new Uint8Array([1, 2]));
  });

  test('places the robot log on the timeline of its samples, and the link log on none', () => {
    const { monitor, link } = setup();
    link.sink.streamOpened({ id: 1, slot: 0, variableIds: [0], clock: 0 });
    link.sink.sample(1, 2_000_000, [1], 0);
    link.sink.log({
      severity: 'info',
      source: 'robot',
      text: 'state RUN',
      at: { clock: 0, timeUs: 2_500_000 },
    });
    link.sink.log({ severity: 'warning', source: 'link', text: 'noted' });
    const [connecting, robot, noted] = monitor.state.log;

    expect(connecting.text).toBe('connecting to ws://robot');
    expect(robot).toMatchObject({ timeUs: 2_500_000, source: 'robot', text: 'state RUN' });
    expect(noted).toMatchObject({ source: 'link', severity: 'warning', text: 'noted' });
    expect(noted.timeUs).toBeUndefined();
  });

  test('keeps the timeline going forward across a reboot, with a boundary at it', () => {
    const { monitor, link, advance } = setup();
    link.sink.streamOpened({ id: 1, slot: 0, variableIds: [1], clock: 0 });
    link.sink.sample(1, 9_000_000, [1], 0);
    advance(2000);
    link.sink.boundary('reboot');
    link.sink.streamOpened({ id: 2, slot: 0, variableIds: [1], clock: 1 });
    link.sink.sample(2, 100, [2], 0);

    expect(monitor.history.boundaries()).toEqual([{ kind: 'reboot', timeUs: 9_000_000 }]);
    expect(monitor.history.latest('speed')?.timeUs).toBe(11_000_000);
    expect(() => link.sink.sample(1, 9_001_000, [1], 0)).not.toThrow();
    expect(monitor.history.latest('speed')?.value).toBe(2);
  });

  test('tells its subscribers of slow changes, and of writes starting or ending', () => {
    const { monitor, link } = setup();
    const heard = vi.fn<() => void>();
    monitor.subscribe(heard);
    const stats: SourceStats = {
      bytesInPerSecond: 10,
      rttMs: 50,
      samplesDropped: 0,
      framesDiscarded: 0,
      gauges: [],
      streams: [],
    };

    link.sink.stats(stats);
    expect(monitor.state.stats).toBe(stats);
    link.pending.set(1, 2.5);
    link.sink.writesChanged();

    expect(heard).toHaveBeenCalledTimes(2);
    expect(monitor.pendingWrite('speed')).toBe(2.5);
  });
});

describe('Monitor driving a source', () => {
  test('asks for variables by name, again when the variables change', () => {
    const { monitor, link } = setup();
    monitor.request([
      { variable: 'state', rateHz: 10, role: 'state' },
      { variable: 'speed', rateHz: 100 },
      { variable: 'ghost', rateHz: 5 },
    ]);
    link.sink.variables([VARIABLES[1]]);

    expect(link.demands.at(-2)).toEqual([
      { variableId: 0, rateHz: 10, role: 'state' },
      { variableId: 1, rateHz: 100 },
    ]);
    expect(link.demands.at(-1)).toEqual([{ variableId: 1, rateHz: 100 }]);
  });

  test('writes and reads by name, and refuses a name the robot does not have', async () => {
    const { monitor, link } = setup();

    await expect(monitor.write('speed', 1.5)).resolves.toEqual({ status: 'confirmed' });
    await expect(monitor.write('ghost', 1)).resolves.toEqual({
      status: 'refused',
      reason: 'no-such-variable',
    });
    await expect(monitor.read('ghost')).resolves.toMatchObject({ status: 'failed' });
    expect(link.writes).toEqual([[1, 1.5]]);
  });

  test('ends a connection with a boundary, and forgets the robot but not its history', async () => {
    const { monitor, link } = setup();
    link.sink.streamOpened({ id: 1, slot: 0, variableIds: [1], clock: 0 });
    link.sink.sample(1, 1000, [1], 0);
    monitor.disconnect();
    link.sink.sample(1, 2000, [2], 0);
    link.sink.status({ kind: 'linked', target: URL, identity: IDENTITY, since: 2 });

    expect(link.closed).toBe(true);
    expect(monitor.state).toMatchObject({
      status: { kind: 'disconnected' },
      identity: null,
      variables: [],
    });
    expect(monitor.state.log.at(-1)?.text).toBe('disconnected');
    expect(monitor.history.boundaries()).toEqual([{ kind: 'reconnect', timeUs: 1000 }]);
    expect(monitor.history.latest('speed')?.value).toBe(1);
    await expect(monitor.command(5)).resolves.toMatchObject({ status: 'failed' });
  });

  test('drops the robot when its connection fails', () => {
    const { monitor, link } = setup();
    link.sink.status({ kind: 'failed', target: URL, message: 'gone' });
    expect(monitor.state.variables).toBe(VARIABLES);
    link.sink.variables([]);

    expect(monitor.state.identity).toBeNull();
    expect(monitor.state.variables).toEqual([]);
  });

  test('starts a new connection at the target asked, ending the one before', () => {
    const { source, monitor, link } = setup();
    monitor.connect({ transport: 'bluetooth' });

    expect(link.closed).toBe(true);
    expect(source.last.target).toEqual({ transport: 'bluetooth' });
    expect(monitor.state.status).toEqual({
      kind: 'connecting',
      target: { transport: 'bluetooth' },
    });
  });
});

describe('Monitor over a recording', () => {
  test('shows what was recorded and never connects', async () => {
    const history = new HistoryStore({ scheduler: new ManualScheduler() });
    const monitor = Monitor.ofRecording(history, IDENTITY, VARIABLES);
    monitor.connect(URL);

    expect(monitor.targets).toEqual([]);
    expect(monitor.state).toMatchObject({
      status: { kind: 'disconnected' },
      identity: IDENTITY,
      variables: VARIABLES,
    });
    await expect(monitor.command(5)).resolves.toEqual({
      status: 'failed',
      message: 'A saved session is on screen: go back to live to send commands.',
    });
  });
});
