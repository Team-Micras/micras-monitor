import { afterEach, describe, expect, test } from 'vitest';

import { WriteStatus } from '../src/protocol';
import { CommandResult, MemorySchemaCache, SessionError } from '../src/link';
import { connect, waitFor, type Harness } from './session-harness';

let harness: Harness | undefined;

async function start(...args: Parameters<typeof connect>): Promise<Harness> {
  harness = await connect(...args);
  return harness;
}

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

describe('a session against the simulated robot', { timeout: 10_000 }, () => {
  test('handshakes and learns the schema', async () => {
    const { session, recording } = await start();

    expect([...new Set(recording.states.map((state) => state.kind))]).toEqual([
      'handshaking',
      'loadingSchema',
      'streaming',
    ]);
    expect(session.robot).toMatchObject({
      protocolVersion: 1,
      loopTimeUs: 125,
      initialCredit: 256,
    });
    expect(session.schema).toHaveLength(23);
    expect(session.schema?.[0]).toMatchObject({
      id: 0,
      name: 'imu/gyro_x',
      access: { stream: true },
    });
    expect(recording.schemas).toMatchObject([{ fromCache: false }]);
  });

  test('streams a group whose samples decode in order', async () => {
    const { session, recording, id } = await start();
    const [epoch] = await session.setGroups([
      { variableIds: [id('imu/accel_z'), id('loop/worst_time_us')], periodTicks: 80 },
    ]);

    await waitFor(() => recording.samplesOf(epoch.id).length >= 20);

    const samples = recording.samplesOf(epoch.id);
    expect(epoch).toMatchObject({ group: 0, periodTicks: 80, sampleSize: 8 });
    expect(recording.epochs).toEqual([epoch]);
    expect(samples.slice(0, 5).map((sample) => sample.seq)).toEqual([0, 1, 2, 3, 4]);
    expect(samples[1].timeUs - samples[0].timeUs).toBe(80 * 125);
    expect(samples[0].values[0]).toBeCloseTo(9.81, 5);
    expect(samples[0].values[1]).toBe(91);
    expect(recording.totalDropped).toBe(0);
    expect(session.stats.creditReturned).toBeGreaterThan(0);
    expect(session.state.kind).toBe('streaming');
  });

  test('a new layout opens a new epoch whose sequence starts over', async () => {
    const { session, recording, id } = await start();
    const [first] = await session.setGroups([{ variableIds: [id('imu/gyro_x')], periodTicks: 40 }]);
    await waitFor(() => recording.samplesOf(first.id).length >= 10);

    const [second, extra] = await session.setGroups([
      { variableIds: [id('imu/gyro_x'), id('imu/gyro_y')], periodTicks: 40 },
      { variableIds: [id('wall/0')], periodTicks: 400 },
    ]);
    await waitFor(() => recording.samplesOf(second.id).length >= 10);

    const lastOfFirst = recording.samples.findLastIndex((sample) => sample.epoch === first.id);
    const firstOfSecond = recording.samples.findIndex((sample) => sample.epoch === second.id);

    expect(second.id).toBeGreaterThan(first.id);
    expect(extra.group).toBe(1);
    expect(recording.samplesOf(second.id)[0].seq).toBe(0);
    expect(recording.samplesOf(second.id)[0].values).toHaveLength(2);
    expect(lastOfFirst).toBeLessThan(firstOfSecond);
    expect(recording.totalDropped).toBe(0);
  });

  test('keeps a write pending until the robot acknowledges it', async () => {
    const { session, recording, id } = await start();
    const profile = id('run_profile');
    const written = session.write(profile, 2);

    expect(session.pendingWrite(profile)).toBe(2);
    expect(recording.writes).toEqual([{ variableId: profile, value: 2, state: 'pending' }]);

    expect(await written).toBe(WriteStatus.OK);
    expect(session.pendingWrite(profile)).toBeUndefined();
    expect(recording.writes.at(-1)).toEqual({ variableId: profile, value: 2, state: 'confirmed' });
    expect(await session.read(profile)).toBe(2);
  });

  test('reports a refused write with its status, never as confirmed', async () => {
    const { session, recording, id } = await start();
    const gyro = id('imu/gyro_x');

    expect(await session.write(gyro, 1.5)).toBe(WriteStatus.READ_ONLY);
    expect(recording.writes.map((write) => write.state)).toEqual(['pending', 'refused']);
    await expect(session.write(id('objective'), 300)).rejects.toThrow('out of range');
  });

  test('reads variables that are not streamed', async () => {
    const { session, id } = await start();

    expect(await session.read(id('imu/accel_z'))).toBeCloseTo(9.81, 5);
    expect(await session.read(id('loop/worst_time_us'))).toBe(91);
  });

  test('runs a command and receives what the robot logs about it', async () => {
    const { session, recording } = await start();

    expect(await session.command(2, 7)).toBe(CommandResult.OK);
    await waitFor(() => recording.logs.length > 0);
    expect(recording.logs[0]).toEqual({ severity: 1, text: 'ran command 2' });
  });

  test('measures the round trip with PING', async () => {
    const { session } = await start();

    await waitFor(() => session.stats.rttMs !== null, 2000);
    expect(session.stats.rttMs).toBeGreaterThanOrEqual(0);
  });

  test('a known schema comes from the cache, without loading it again', async () => {
    const schemaCache = new MemorySchemaCache();
    const first = await start({}, { schemaCache });
    await first.close();

    const { recording } = await start({}, { schemaCache });

    expect(recording.schemas).toMatchObject([{ fromCache: true }]);
    expect(recording.states.some((state) => state.kind === 'loadingSchema')).toBe(false);
  });

  test('fails every pending request when closed', async () => {
    const { session, robot, id } = await start({ latencyMs: 100 });
    const read = session.read(id('imu/gyro_x')).catch((error: unknown) => error);

    session.close();

    expect(await read).toBeInstanceOf(SessionError);
    expect(session.state.kind).toBe('closed');
    await robot.close();
    harness = undefined;
  });
});
