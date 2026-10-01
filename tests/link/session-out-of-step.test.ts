import { afterEach, describe, expect, test } from 'vitest';

import { encodeGroupDefine, encodeGroupEnable } from '@/link/messages';
import { applyGroups, connect, waitFor, type Harness } from '@tests/support/session-harness';
import { useVirtualTime } from '@tests/support/virtual-time';

let harness: Harness | undefined;

useVirtualTime();

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

/** Change a group on the robot behind the session's back, as a second monitor on the link would. */
function redefineBehindTheSession(
  { robot }: Harness,
  group: number,
  periodTicks: number,
  variableIds: readonly number[]
): void {
  const reached = robot.robot;

  if (!reached) {
    throw new Error('The robot is not connected');
  }

  reached.receive(encodeGroupDefine(group, periodTicks, variableIds));
  reached.receive(encodeGroupEnable(group, true));
}

describe('a session whose group the robot streams out of step', { timeout: 10_000 }, () => {
  test('defines a group again when its samples have another layout, counting none as dropped', async () => {
    harness = await connect();
    const { session, recording, id } = harness;
    const layout = [id('imu/accel_z'), id('loop/worst_time_us')];
    const [first] = await applyGroups(session, [{ variableIds: layout, periodTicks: 80 }]);
    await waitFor(() => recording.samplesOf(first.id).length >= 10, 5000, 'the first samples');

    redefineBehindTheSession(harness, 0, 40, [
      id('imu/gyro_x'),
      id('imu/gyro_y'),
      id('imu/gyro_z'),
    ]);

    await waitFor(
      () =>
        recording.epochs.some(
          (epoch) => epoch.id !== first.id && recording.samplesOf(epoch.id).length >= 10
        ),
      5000,
      'the group to stream its own layout again'
    );

    const again = recording.epochs.at(-1);
    expect(again).toMatchObject({
      group: 0,
      variableIds: layout,
      periodTicks: 80,
      sampleSize: 8,
    });
    expect(recording.samples.every((sample) => sample.values.length === 2)).toBe(true);
    expect(recording.totalDropped).toBe(0);
    expect(recording.timelines.map((timeline) => timeline.reason)).toEqual(['connected']);
    expect(recording.protocolErrors.map((error) => error.message)).toContain(
      'A sample of group 0 has 12 bytes; 8 were acknowledged'
    );
    expect(session.openEpochs).toEqual([again]);
  });

  test('takes a sequence that starts over behind the expected one as out of step, not as a wrap', async () => {
    harness = await connect();
    const { session, recording, id } = harness;
    const layout = [id('imu/accel_z'), id('loop/worst_time_us')];
    const [first] = await applyGroups(session, [{ variableIds: layout, periodTicks: 80 }]);
    await waitFor(() => recording.samplesOf(first.id).length >= 30, 5000, 'the first samples');

    redefineBehindTheSession(harness, 0, 80, layout);

    await waitFor(
      () =>
        recording.epochs.some(
          (epoch) => epoch.id !== first.id && recording.samplesOf(epoch.id).length >= 10
        ),
      5000,
      'the group to stream in step again'
    );

    const sequences = recording.samplesOf(first.id).map((sample) => sample.seq);
    expect(sequences).toEqual(sequences.map((_, index) => index));
    expect(recording.totalDropped).toBe(0);
    expect(recording.timelines.map((timeline) => timeline.reason)).toEqual(['connected']);
    expect(recording.protocolErrors.map((error) => error.message)).toContainEqual(
      expect.stringMatching(/^A sample of group 0 came with sequence 0; \d+ was expected$/)
    );
    expect(session.state.kind).toBe('streaming');
  });
});
