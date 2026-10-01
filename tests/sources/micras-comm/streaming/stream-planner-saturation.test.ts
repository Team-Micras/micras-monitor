import { afterEach, describe, expect, test } from 'vitest';

import type { GroupRequest } from '@/sources/micras-comm/link/group-configurator';
import type { RobotLink } from '@/sources/micras-comm/link/robot-link';
import { fitGroups, type RateRequest } from '@/sources/micras-comm/streaming/fit-groups';
import { StreamPlanner, type PlannerLink } from '@/sources/micras-comm/streaming/stream-planner';
import { CREDIT_WINDOW } from '@/sources/micras-comm/wire';
import {
  connect,
  delay,
  TEST_TIMING,
  type Harness,
} from '@tests/support/sources/micras-comm/link-harness';
import { useVirtualTime } from '@tests/support/virtual-time';

const PINNED: readonly RateRequest[] = [
  { variable: 'state', rateHz: 10, pinned: true },
  { variable: 'link/dropped_samples', rateHz: 1, pinned: true, countsDrops: true },
  { variable: 'link/credit', rateHz: 2, pinned: true },
];
const SIGNALS = [
  'imu/gyro_x',
  'imu/gyro_y',
  'imu/gyro_z',
  'imu/accel_x',
  'imu/accel_y',
  'imu/accel_z',
  'wall/0',
  'wall/1',
  'wall/2',
  'wall/3',
];
const OVER_CAPACITY = 1.4;
/** Hold periods after a failed probe before the next, long enough that none falls in the watch. */
const QUIET_HOLDS = 30;
const SETTLE_S = 90;
/** What a stall-free link carries easily, with room to spare. */
const STALL_DEMAND = 5956;
/** How long, after a long stall, the plan may take to give back all that was asked. */
const RECOVERY_S = 30;
/** What the planner settles on over a clean HM-19 that carries 3 KB/s, with the default timing. */
const HM19_CLEAN_BUDGET = 2830;
/** How long, after a stall that left the round trip at 120 ms, the budget may take to rise. */
const RELAYED_RECOVERY_S = 150;
/** The budget it has to reach by then, well above where the stall left it. */
const RELAYED_LEAST = 1000;
/** How long the budget over a corrupting HM-19 is watched for. */
const CORRUPT_WATCH_S = 60;
/** How long the default probe cycle is watched for. */
const CYCLE_MINUTES = 3;
const WATCH_S = 30;

let harness: Harness | undefined;
let planner: StreamPlanner | undefined;

useVirtualTime();

afterEach(async () => {
  planner?.close();
  planner = undefined;
  await harness?.close();
  harness = undefined;
});

/** The link, counting every plan it is asked to apply. */
function counted(link: RobotLink, applied: (readonly GroupRequest[])[]): PlannerLink {
  return {
    on: (event, listener) => link.on(event, listener),
    get schema() {
      return link.schema;
    },
    get robot() {
      return link.robot;
    },
    get openEpochs() {
      return link.openEpochs;
    },
    setGroups: (groups) => {
      applied.push(groups);
      return link.setGroups(groups);
    },
  };
}

/** The pinned roles, and every signal at one rate. */
function requests(rateHz: number): RateRequest[] {
  return [...PINNED, ...SIGNALS.map((variable) => ({ variable, rateHz }))];
}

/** Requests whose groups take about `bytesPerSecond` at the rates asked. */
function demanding(link: RobotLink, bytesPerSecond: number): RateRequest[] {
  const demand = (rateHz: number) =>
    fitGroups({
      schema: link.schema ?? [],
      loopTimeUs: link.robot?.loopTimeUs ?? 125,
      requests: requests(rateHz),
      budgetBytesPerSecond: Number.POSITIVE_INFINITY,
    }).usedBytesPerSecond;
  let rateHz = 1;

  while (demand(rateHz + 1) <= bytesPerSecond) {
    rateHz++;
  }

  return requests(rateHz);
}

describe('a planner over a saturated link', { timeout: 120_000 }, () => {
  test.each([
    {
      name: 'a WebSocket over a 30 ms round trip to a monitor that stalls 120 ms a second',
      faults: { latencyMs: 10, jitterMs: 10, stallMs: 120 },
      demand: 2400,
      least: 600,
    },
    {
      name: 'a relayed WebSocket bound by the credit window over a jittery 100 ms round trip',
      faults: { latencyMs: 30, jitterMs: 40 },
      demand: ((CREDIT_WINDOW * 1000) / 100) * OVER_CAPACITY,
      least: 1000,
    },
    {
      name: 'an HM-19 that carries 3 KB/s',
      faults: { throughputBytesPerSecond: 3000, latencyMs: 20 },
      demand: 3000 * OVER_CAPACITY,
      least: 1500,
    },
  ])(
    'backs off until $name stops dropping, and holds one plan',
    async ({ faults, demand, least }) => {
      harness = await connect(faults, { timing: { ...TEST_TIMING, statsIntervalMs: 1000 } });
      const { link, robot } = harness;
      const applied: (readonly GroupRequest[])[] = [];
      planner = new StreamPlanner(counted(link, applied), {
        debounceMs: 20,
        budget: { quietHolds: QUIET_HOLDS },
      });
      planner.request(demanding(link, demand));

      await delay(SETTLE_S * 1000);
      const settled = { robot: robot.stats.samplesDropped, seen: link.stats.droppedSamples };
      const plansBefore = applied.length;
      await delay(WATCH_S * 1000);

      const used = planner.plan?.usedBytesPerSecond ?? 0;
      expect(robot.stats.samplesDropped - settled.robot).toBe(0);
      expect(link.stats.droppedSamples - settled.seen).toBe(0);
      expect(applied.length - plansBefore).toBe(0);
      expect(planner.plan?.overBudget).toBe(true);
      expect(used).toBeGreaterThan(least);
    }
  );

  test.each([
    { stallS: 30, stallMs: 600 },
    { stallS: 120, stallMs: 600 },
    { stallS: 120, stallMs: 400 },
  ])(
    'gets back to what was asked within a few holds once $stallS s of $stallMs ms stalls are over',
    async ({ stallS, stallMs }) => {
      harness = await connect({ latencyMs: 10 }, { timing: {} });
      const { link, robot } = harness;
      planner = new StreamPlanner(link, { debounceMs: 20 });
      planner.request(demanding(link, STALL_DEMAND));

      await delay(20_000);
      expect(planner.plan?.overBudget).toBe(false);
      robot.faults.stallMs = stallMs;
      await delay(stallS * 1000);
      const stalled = planner.plan?.usedBytesPerSecond ?? 0;
      robot.faults.stallMs = 0;
      await delay(RECOVERY_S * 1000);

      expect(stalled).toBeLessThan(STALL_DEMAND / 2);
      expect(planner.plan?.overBudget).toBe(false);
    }
  );

  test('probes back up after a stall that leaves the round trip longer for good', async () => {
    harness = await connect({ latencyMs: 10 }, { timing: {} });
    const { link, robot } = harness;
    planner = new StreamPlanner(link, { debounceMs: 20 });
    planner.request(demanding(link, STALL_DEMAND));

    await delay(20_000);
    robot.faults.stallMs = 600;
    await delay(30_000);
    const stalled = planner.budget.bytesPerSecond;
    robot.faults.stallMs = 0;
    robot.faults.latencyMs = 60;
    await delay(RELAYED_RECOVERY_S * 1000);

    expect(stalled).toBeLessThan(RELAYED_LEAST);
    expect(planner.budget.bytesPerSecond).toBeGreaterThanOrEqual(RELAYED_LEAST);
  });

  test('keeps what was asked on a fast link that corrupts frames', async () => {
    harness = await connect(
      { corruptRate: 0.05, seed: 3 },
      { timing: { ...TEST_TIMING, statsIntervalMs: 1000 } }
    );
    const { link } = harness;
    planner = new StreamPlanner(link, { debounceMs: 20 });
    planner.request(demanding(link, 3000).filter((request) => request.countsDrops !== true));

    await delay(60_000);

    expect(link.stats.framesDiscarded).toBeGreaterThan(100);
    expect(planner.budget.bytesPerSecond).toBeGreaterThan(3000);
    expect(planner.plan?.overBudget).toBe(false);
  });

  test('keeps its budget on an HM-19 that corrupts frames while the robot counts drops', async () => {
    harness = await connect(
      { throughputBytesPerSecond: 3000, latencyMs: 20, corruptRate: 0.02, seed: 5 },
      { timing: {} }
    );
    const { link } = harness;
    planner = new StreamPlanner(link, { debounceMs: 20 });
    planner.request(demanding(link, 3000 * OVER_CAPACITY));

    await delay(SETTLE_S * 1000);
    const budgets: number[] = [];
    const sample = setInterval(() => budgets.push(planner?.budget.bytesPerSecond ?? 0), 1000);
    await delay(CORRUPT_WATCH_S * 1000);
    clearInterval(sample);

    expect(link.stats.framesDiscarded).toBeGreaterThan(50);
    const mean = budgets.reduce((total, budget) => total + budget, 0) / budgets.length;
    expect(mean).toBeGreaterThanOrEqual(HM19_CLEAN_BUDGET * 0.5);
    expect(Math.min(...budgets)).toBeGreaterThanOrEqual(HM19_CLEAN_BUDGET * 0.3);
  });

  test('with the default probe cycle, drops and plans stay rare once settled', async () => {
    harness = await connect(
      { latencyMs: 10, jitterMs: 10, stallMs: 120 },
      { timing: { ...TEST_TIMING, statsIntervalMs: 1000 } }
    );
    const { link, robot } = harness;
    const applied: (readonly GroupRequest[])[] = [];
    planner = new StreamPlanner(counted(link, applied), { debounceMs: 20 });
    planner.request(demanding(link, 2400));

    await delay(60_000);
    const dropsBefore = robot.stats.samplesDropped;
    const plansBefore = applied.length;
    await delay(CYCLE_MINUTES * 60_000);

    expect((robot.stats.samplesDropped - dropsBefore) / CYCLE_MINUTES).toBeLessThanOrEqual(3);
    expect((applied.length - plansBefore) / CYCLE_MINUTES).toBeLessThanOrEqual(2);
  });
});
