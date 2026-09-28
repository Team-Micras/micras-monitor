import { afterEach, describe, expect, test } from 'vitest';

import { connect, delay, waitFor, type Harness } from './session-harness';
import { createVariables } from './simulated-robot/variables';

let harness: Harness | undefined;

async function start(...args: Parameters<typeof connect>): Promise<Harness> {
  harness = await connect(...args);
  return harness;
}

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

const FOUR_SIGNALS = ['imu/gyro_x', 'imu/gyro_y', 'imu/gyro_z', 'wall/0'];
const EIGHT_SIGNALS = [...FOUR_SIGNALS, 'wall/1', 'wall/2', 'wall/3', 'cmd/linear'];

describe('a session recovers from what a radio link does', { timeout: 15_000 }, () => {
  test.each([0, 1])('schema page %i lost on the way is asked for again', async (page) => {
    const { session, robot, recording } = await start({ dropSchemaPage: page });

    expect(robot.stats.schemaPagesDropped).toBe(1);
    expect(recording.handshakeReasons).toEqual(['connected', 'schema-retry']);
    expect(session.schema?.map((entry) => entry.name)).toEqual(
      createVariables().map((variable) => variable.name)
    );
    expect(recording.schemas).toHaveLength(1);
  });

  test('credit lost stalls the stream, and a fresh HELLO resumes it', async () => {
    const { session, robot, recording, id } = await start({ dropCredits: 3 });
    const [first] = await session.setGroups([
      { variableIds: FOUR_SIGNALS.map(id), periodTicks: 8 },
    ]);

    await waitFor(() => recording.handshakeReasons.includes('stall'), 3000, 'a stall');
    await waitFor(() => session.openEpochs.length === 1 && session.openEpochs[0].id !== first.id);

    const [resumed] = session.openEpochs;
    await waitFor(() => recording.samplesOf(resumed.id).length >= 200, 3000, 'samples to resume');

    expect(robot.stats.creditFramesDropped).toBe(3);
    expect(recording.samplesOf(first.id).length).toBeLessThan(20);
    expect(recording.handshakeReasons).toEqual(['connected', 'stall']);
    expect(robot.stats.hellos).toBe(2);
  });

  test('corrupted frames are counted and never credited', async () => {
    const { session, robot, recording, id } = await start({ corruptRate: 0.05, seed: 7 });
    await session.setGroups([{ variableIds: FOUR_SIGNALS.map(id), periodTicks: 16 }]);
    await delay(2000);
    await session.setGroups([]).catch(() => undefined);

    await waitFor(
      () =>
        session.stats.framesDiscarded === robot.stats.corruptedFrames &&
        session.stats.creditReturned === robot.stats.creditReceived,
      3000,
      'the counters to settle'
    );

    expect(robot.stats.corruptedMeteredBytes).toBeGreaterThan(0);
    expect(session.stats.framesDiscarded).toBeGreaterThan(10);
    expect(session.stats.creditReturned).toBeLessThanOrEqual(
      robot.stats.meteredBytes - robot.stats.corruptedMeteredBytes
    );
    expect(recording.samples.length).toBeGreaterThan(100);
  });

  test('a robot that reboots is picked up again, with its clock starting over', async () => {
    const { session, robot, recording, id } = await start({ rebootAfterSeconds: 1 });
    const [before] = await session.setGroups([
      { variableIds: [id('imu/gyro_x')], periodTicks: 80 },
    ]);

    await waitFor(() => robot.stats.reboots === 1, 3000, 'the reboot');
    await waitFor(() => session.openEpochs.some((epoch) => epoch.id !== before.id), 3000);

    const [after] = session.openEpochs;
    await waitFor(() => recording.samplesOf(after.id).length >= 10);

    const lastBefore = recording.samplesOf(before.id).at(-1);
    const firstAfter = recording.samplesOf(after.id)[0];

    expect(recording.handshakeReasons).toEqual(['connected', 'stall']);
    expect(session.stats.clockResets).toBe(1);
    expect(firstAfter.timeUs).toBeLessThan(lastBefore?.timeUs ?? 0);
    expect(firstAfter.seq).toBe(0);
  });

  test('a throughput limited link drops samples visibly but never stalls', async () => {
    const { session, robot, recording, id } = await start({
      throughputBytesPerSecond: 3000,
      latencyMs: 20,
    });
    await session.setGroups([{ variableIds: EIGHT_SIGNALS.map(id), periodTicks: 8 }]);

    const bytesBefore = session.stats.bytesIn;
    const startedAt = performance.now();
    await delay(3000);
    const seconds = (performance.now() - startedAt) / 1000;
    const bytesPerSecond = (session.stats.bytesIn - bytesBefore) / seconds;

    expect(recording.handshakeReasons).toEqual(['connected']);
    expect(session.state.kind).toBe('streaming');
    expect(bytesPerSecond).toBeLessThanOrEqual(3100);
    expect(bytesPerSecond).toBeGreaterThan(1500);
    expect(recording.samples.length).toBeGreaterThan(150);
    expect(recording.totalDropped).toBeGreaterThan(500);
    expect(recording.totalDropped).toBeLessThanOrEqual(robot.stats.samplesDropped);
  });
});
