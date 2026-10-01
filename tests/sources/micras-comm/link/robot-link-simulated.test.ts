import { afterEach, describe, expect, test } from 'vitest';

import { CommandResult, TypeCode, WriteStatus } from '@/sources/micras-comm/wire';
import { MemorySchemaCache } from '@/sources/micras-comm/link/schema';
import { LinkError } from '@/sources/micras-comm/link/errors';
import {
  applyGroups,
  connect,
  waitFor,
  type Harness,
} from '@tests/support/sources/micras-comm/link-harness';
import { RobotState } from '@scripts/simulated-robot/commands';
import { useVirtualTime } from '@tests/support/virtual-time';

let harness: Harness | undefined;

useVirtualTime();

async function start(...args: Parameters<typeof connect>): Promise<Harness> {
  harness = await connect(...args);
  return harness;
}

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

describe('a link against the simulated robot', { timeout: 10_000 }, () => {
  test('handshakes and learns the schema', async () => {
    const { link, recording } = await start();

    expect([...new Set(recording.states.map((state) => state.kind))]).toEqual([
      'handshaking',
      'loadingSchema',
      'streaming',
    ]);
    expect(link.robot).toMatchObject({
      protocolVersion: 2,
      loopTimeUs: 125,
      creditWindow: 256,
      robotName: 'micras',
    });
    expect(link.schema).toHaveLength(26);
    expect(link.schema?.[2]).toMatchObject({
      id: 2,
      name: 'imu/gyro_x',
      access: { stream: true },
    });
    expect(link.schema?.[1]).toMatchObject({
      name: 'maze',
      type: TypeCode.BLOB,
      typeTag: 'maze-grid',
    });
    expect(recording.schemas).toMatchObject([{ fromCache: false }]);
  });

  test('streams a group whose samples decode in order', async () => {
    const { link, recording, id } = await start();
    const [epoch] = await applyGroups(link, [
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
    expect(link.stats.creditReturned).toBeGreaterThan(0);
    expect(link.state.kind).toBe('streaming');
  });

  test('a new layout opens a new epoch whose sequence starts over', async () => {
    const { link, recording, id } = await start();
    const [first] = await applyGroups(link, [{ variableIds: [id('imu/gyro_x')], periodTicks: 40 }]);
    await waitFor(() => recording.samplesOf(first.id).length >= 10);

    const [second, extra] = await applyGroups(link, [
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
    const { link, recording, id } = await start();
    const profile = id('run_profile');
    const written = link.write(profile, 2);

    expect(link.pendingWrite(profile)).toBe(2);
    expect(recording.writes).toEqual([{ variableId: profile, value: 2, state: 'pending' }]);

    expect(await written).toEqual({ status: 'answered', writeStatus: WriteStatus.OK });
    expect(link.pendingWrite(profile)).toBeUndefined();
    expect(recording.writes.at(-1)).toEqual({ variableId: profile, value: 2, state: 'confirmed' });
    expect(await link.read(profile)).toBe(2);
  });

  test('reports a refused write with its status, never as confirmed', async () => {
    const { link, recording, id } = await start();
    const gyro = id('imu/gyro_x');

    expect(await link.write(gyro, 1.5)).toEqual({
      status: 'answered',
      writeStatus: WriteStatus.READ_ONLY,
    });
    expect(recording.writes.map((write) => write.state)).toEqual(['pending', 'refused']);
    await expect(link.write(id('objective'), 300)).rejects.toThrow('out of range');
  });

  test('reads variables that are not streamed', async () => {
    const { link, id } = await start();

    expect(await link.read(id('imu/accel_z'))).toBeCloseTo(9.81, 5);
    expect(await link.read(id('loop/worst_time_us'))).toBe(91);
  });

  test('runs a command and receives what the robot logs about it', async () => {
    const { link, recording, id } = await start();

    expect(await link.command(2, 7)).toEqual({ result: CommandResult.OK });
    await waitFor(() => recording.logs.length > 0);
    expect(recording.logs[0]).toMatchObject({ severity: 1, text: 'state CALIBRATE' });
    expect(recording.logs[0].timeUs).toBeGreaterThan(0);
    expect(await link.read(id('state'))).toBe(7);
  });

  test('refuses what the state does not accept, with the reason', async () => {
    const { link, robot } = await start();

    expect(await link.command(0)).toEqual({ result: CommandResult.OK });
    expect(await link.command(1)).toEqual({ result: CommandResult.REFUSED, reason: 1 });
    expect(await link.command(6)).toEqual({ result: CommandResult.REFUSED, reason: 4 });
    expect(await link.command(9)).toEqual({ result: CommandResult.UNKNOWN });
    expect(await link.command(5)).toEqual({ result: CommandResult.OK });

    robot.robot?.fault();

    expect(await link.command(0)).toEqual({ result: CommandResult.REFUSED, reason: 1 });
    expect(await link.command(5)).toEqual({ result: CommandResult.OK });
    expect(robot.robot?.robotState).toBe(RobotState.ERROR);
    expect(await link.command(6)).toEqual({ result: CommandResult.OK });
    expect(robot.robot?.robotState).toBe(RobotState.IDLE);
  });

  test('brakes to a standstill on a stop during a run before it is idle', async () => {
    const { link, robot, id } = await start();

    expect(await link.command(0)).toEqual({ result: CommandResult.OK });
    expect(await link.command(5)).toEqual({ result: CommandResult.OK });
    expect(robot.robot?.robotState).toBe(RobotState.BRAKE);
    expect(await link.read(id('state'))).toBe(13);
    expect(await link.command(5)).toEqual({ result: CommandResult.OK });
    expect(await link.command(0)).toEqual({ result: CommandResult.REFUSED, reason: 1 });

    await waitFor(() => robot.robot?.robotState === RobotState.IDLE, 2000, 'the braking to end');
  });

  test('counts the frames it could not read, as the firmware does', async () => {
    const { link, robot, id } = await start();

    robot.robot?.receive(new Uint8Array([5, 9, 9, 9, 9, 0]));

    expect(await link.read(id('link/discarded_frames'))).toBe(1);
  });

  test('defers a stop that arrives while the maze is being saved', async () => {
    const { link, robot } = await start();

    expect(await link.command(3)).toEqual({ result: CommandResult.OK });
    expect(await link.command(5)).toEqual({ result: CommandResult.DEFERRED, reason: 2 });
    expect(await link.command(4)).toEqual({ result: CommandResult.REFUSED, reason: 2 });
    await waitFor(() => robot.robot?.robotState === RobotState.IDLE, 2000, 'the save to end');
  });

  test('reads the bytes of a blob', async () => {
    const { link, id } = await start();

    expect(await link.read(id('maze'))).toHaveLength(131);
  });

  test('measures the round trip with PING', async () => {
    const { link } = await start();

    await waitFor(() => link.stats.rttMs !== null, 2000);
    expect(link.stats.rttMs).toBeGreaterThanOrEqual(0);
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
    const { link, robot, id } = await start({ latencyMs: 100 });
    const read = link.read(id('imu/gyro_x')).catch((error: unknown) => error);

    link.close();

    expect(await read).toBeInstanceOf(LinkError);
    expect(link.state.kind).toBe('closed');
    robot.close();
    harness = undefined;
  });
});
