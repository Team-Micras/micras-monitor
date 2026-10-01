import { afterEach, describe, expect, test } from 'vitest';

import {
  applyGroups,
  connect,
  waitFor,
  type Harness,
} from '@tests/support/sources/micras-comm/link-harness';
import { createVariables } from '@scripts/simulated-robot/variables';
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

const FOUR_SIGNALS = ['imu/gyro_x', 'imu/gyro_y', 'imu/gyro_z', 'wall/0'];
const EIGHT_SIGNALS = [...FOUR_SIGNALS, 'wall/1', 'wall/2', 'wall/3', 'cmd/linear'];

describe('a session recovers from what a radio link does', { timeout: 15_000 }, () => {
  test.each([
    [0, ['connected']],
    [1, ['connected']],
    [2, ['connected', 'schema-retry']],
  ])('schema page %i lost on the way is asked for again', async (page, reasons) => {
    const { session, robot, recording } = await start({ dropSchemaPage: page });

    expect(robot.stats.schemaPagesDropped).toBe(1);
    expect(recording.handshakeReasons).toEqual(reasons);
    expect(session.schema?.map((entry) => entry.name)).toEqual(
      createVariables().map((variable) => variable.name)
    );
    expect(recording.schemas).toHaveLength(1);
  });

  test('lost CREDITs cost nothing, because the next one carries the total', async () => {
    const { session, robot, recording, id } = await start({ dropCredits: 3 });
    const [epoch] = await applyGroups(session, [
      { variableIds: FOUR_SIGNALS.map(id), periodTicks: 8 },
    ]);

    await waitFor(() => recording.samplesOf(epoch.id).length >= 300, 5000, 'samples to flow');

    expect(robot.stats.creditFramesDropped).toBe(3);
    expect(recording.handshakeReasons).toEqual(['connected']);
    expect(session.openEpochs).toEqual([epoch]);
  });

  test('corrupted frames are counted, and PONG gives back the credit they took', async () => {
    const { session, robot, recording, id } = await start({ corruptRate: 0.05, seed: 7 });
    await applyGroups(session, [{ variableIds: FOUR_SIGNALS.map(id), periodTicks: 16 }]);
    await waitFor(() => recording.samples.length >= 400, 8000, 'samples through the noise');
    await applyGroups(session, []).catch(() => undefined);

    await waitFor(
      () =>
        session.stats.framesDiscarded === robot.stats.corruptedFrames &&
        session.stats.creditReturned === robot.stats.creditReceived,
      3000,
      'the counters to settle'
    );

    expect(robot.stats.corruptedMeteredBytes).toBeGreaterThan(0);
    expect(session.stats.framesDiscarded).toBeGreaterThan(10);
    expect(session.stats.creditRecovered).toBeGreaterThan(0);
    expect(session.stats.creditReturned - session.stats.creditRecovered).toBeLessThanOrEqual(
      robot.stats.meteredBytes - robot.stats.corruptedMeteredBytes
    );
    expect(recording.handshakeReasons).not.toContain('stall');
  });

  test('a radio buffer that overflows loses frames the robot never knew of, and PONG recovers them', async () => {
    const { session, robot, recording, id } = await start({
      throughputBytesPerSecond: 2000,
      radioBufferBytes: 220,
    });
    await applyGroups(session, [{ variableIds: EIGHT_SIGNALS.map(id), periodTicks: 8 }]);

    await waitFor(() => session.stats.creditRecovered > 0, 5000, 'credit to be recovered');
    const samples = recording.samples.length;
    await waitFor(() => recording.samples.length >= samples + 20, 5000, 'samples to go on');

    expect(robot.stats.radioOverflowBytes).toBeGreaterThan(0);
    expect(recording.handshakeReasons).not.toContain('stall');
  });

  test('a robot that reboots is picked up again on a new timeline', async () => {
    const { session, robot, recording, id } = await start({ rebootAfterSeconds: 1 });
    const [before] = await applyGroups(session, [
      { variableIds: [id('imu/gyro_x')], periodTicks: 80 },
    ]);

    await waitFor(() => robot.stats.reboots === 1, 3000, 'the reboot');
    await waitFor(
      () => session.openEpochs.some((epoch) => epoch.id !== before.id),
      3000,
      'the layout on the new boot'
    );

    const [after] = session.openEpochs;
    await waitFor(() => recording.samplesOf(after.id).length >= 10, 3000, 'samples after it');

    const lastBefore = recording.samplesOf(before.id).at(-1);
    const firstAfter = recording.samplesOf(after.id)[0];

    expect(recording.handshakeReasons).toEqual(['connected', 'credit-resync']);
    expect(recording.timelines.map((timeline) => timeline.reason)).toEqual(['connected', 'reboot']);
    expect(after.timeline).toBe(before.timeline + 1);
    expect(session.stats.clockResets).toBe(0);
    expect(firstAfter.timeUs).toBeLessThan(lastBefore?.timeUs ?? 0);
    expect(firstAfter.seq).toBe(0);
  });

  test('a throughput limited link drops samples visibly but never stalls', async () => {
    const { session, robot, recording, id } = await start({
      throughputBytesPerSecond: 3000,
      latencyMs: 20,
    });
    await applyGroups(session, [{ variableIds: EIGHT_SIGNALS.map(id), periodTicks: 8 }]);

    const bytesBefore = session.stats.bytesIn;
    const startedAt = performance.now();
    await waitFor(() => session.stats.bytesIn >= bytesBefore + 6000, 8000, '6000 bytes to arrive');
    const seconds = (performance.now() - startedAt) / 1000;
    const bytesPerSecond = (session.stats.bytesIn - bytesBefore) / seconds;
    await waitFor(() => recording.totalDropped > 500, 5000, 'samples to be dropped');

    expect(recording.handshakeReasons).toEqual(['connected']);
    expect(session.state.kind).toBe('streaming');
    expect(bytesPerSecond).toBeLessThanOrEqual(3200);
    expect(bytesPerSecond).toBeGreaterThan(1500);
    expect(recording.samples.length).toBeGreaterThan(50);
    expect(recording.totalDropped).toBeLessThanOrEqual(robot.stats.samplesDropped);
  });
});
