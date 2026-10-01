import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { decodeAccess, ErrorCode, TypeCode } from '@/sources/micras-comm/wire';
import { Emitter } from '@/core/emitter';
import { RobotError, SessionError } from '@/sources/micras-comm/link/errors';
import type { Epoch, GroupRequest } from '@/sources/micras-comm/link/epochs';
import type { SchemaEntry } from '@/sources/micras-comm/link/schema';
import type {
  GroupsResult,
  LinkStats,
  RobotInfo,
  SessionEvents,
} from '@/sources/micras-comm/link/link-events';
import { StreamPlanner, type PlannerSession } from '@/sources/micras-comm/streaming/stream-planner';

const STREAM = decodeAccess(0x01);
const SCHEMA: SchemaEntry[] = ['a', 'b', 'c'].map((name, id) => ({
  id,
  name,
  type: TypeCode.F32,
  access: STREAM,
}));
const ROBOT: RobotInfo = {
  protocolVersion: 2,
  schemaHash: 1,
  variableCount: SCHEMA.length,
  loopTimeUs: 125,
  creditWindow: 256,
  bootId: 1,
  robotName: 'robot',
};
const STATS: LinkStats = {
  bytesIn: 0,
  bytesOut: 0,
  framesIn: 0,
  framesDiscarded: 0,
  framesUndecodable: 0,
  creditReturned: 0,
  creditRecovered: 0,
  rttMs: 5,
  samples: 0,
  droppedSamples: 0,
  handshakes: 1,
  clockResets: 0,
};

class FakeSession implements PlannerSession {
  readonly events = new Emitter<SessionEvents>();
  readonly calls: GroupRequest[][] = [];
  schema: readonly SchemaEntry[] | undefined = SCHEMA;
  robot: RobotInfo | undefined = ROBOT;
  openEpochs: readonly Epoch[] = [];
  answer: (groups: readonly GroupRequest[]) => Promise<GroupsResult> = () =>
    Promise.resolve({ status: 'applied', epochs: [] });

  on: PlannerSession['on'] = (event, listener) => this.events.on(event, listener);

  setGroups(requests: readonly GroupRequest[]): Promise<GroupsResult> {
    this.calls.push([...requests]);
    return this.answer(requests);
  }
}

function epochOf(id: number, variableIds: number[]): Epoch {
  return { id, group: 0, variableIds, periodTicks: 80, sampleSize: 4, timeline: 1 };
}

let session: FakeSession;
let planner: StreamPlanner;

beforeEach(() => {
  vi.useFakeTimers();
  session = new FakeSession();
  planner = new StreamPlanner(session, { debounceMs: 10, retryMs: 100, now: () => Date.now() });
});

afterEach(() => {
  planner.close();
  vi.useRealTimers();
});

describe('StreamPlanner', () => {
  test('plans once a burst of requests settles, and not again for equal requests', async () => {
    planner.request([{ variable: 'a', rateHz: 10 }]);
    planner.request([{ variable: 'a', rateHz: 100 }]);
    await vi.advanceTimersByTimeAsync(20);
    planner.request([{ variable: 'a', rateHz: 100 }]);
    await vi.advanceTimersByTimeAsync(20);

    expect(session.calls).toEqual([[{ variableIds: [0], periodTicks: 80 }]]);
  });

  test('ignores a plan the session dropped because it restarted or lost the transport', async () => {
    const errors: Error[] = [];
    planner.on('error', (error) => errors.push(error));
    session.answer = () => Promise.reject(new SessionError('restarted'));
    planner.request([{ variable: 'a', rateHz: 10 }]);
    await vi.advanceTimersByTimeAsync(20);
    session.answer = () => Promise.reject(new SessionError('disconnected'));
    planner.request([{ variable: 'b', rateHz: 10 }]);
    await vi.advanceTimersByTimeAsync(1000);

    expect(errors).toEqual([]);
    expect(session.calls).toHaveLength(2);
  });

  test('plans again after a refusal, leaving out what the robot would not stream', async () => {
    const errors: Error[] = [];
    planner.on('error', (error) => errors.push(error));
    session.answer = () => {
      session.openEpochs = [epochOf(1, [0])];
      return Promise.reject(new RobotError(ErrorCode.NOT_STREAMABLE, 1));
    };
    planner.request([
      { variable: 'a', rateHz: 100 },
      { variable: 'b', rateHz: 10 },
    ]);
    await vi.advanceTimersByTimeAsync(20);

    expect(errors).toHaveLength(1);
    session.answer = () => Promise.resolve({ status: 'applied', epochs: session.openEpochs });
    await vi.advanceTimersByTimeAsync(100);

    expect(session.calls.at(-1)).toEqual([{ variableIds: [0], periodTicks: 80 }]);
    expect(planner.plan?.rates.find((rate) => rate.variable === 'b')?.grantedHz).toBe(0);
  });

  test('tries again with a growing wait when the robot does not answer', async () => {
    session.answer = () => Promise.reject(new Error('No answer'));
    planner.request([{ variable: 'a', rateHz: 10 }]);
    await vi.advanceTimersByTimeAsync(20);
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(150);

    expect(session.calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(60);
    expect(session.calls).toHaveLength(3);
    expect(planner.plan?.rates[0].grantedHz).toBeGreaterThan(0);
  });

  test('plans again at once when the link overflows while a retry waits', async () => {
    planner.close();
    planner = new StreamPlanner(session, {
      debounceMs: 10,
      retryMs: 10_000,
      now: () => Date.now(),
    });
    session.answer = () => Promise.reject(new Error('No answer'));
    planner.request([{ variable: 'a', rateHz: 1000 }]);
    await vi.advanceTimersByTimeAsync(20);
    session.events.emit('stats', STATS);
    await vi.advanceTimersByTimeAsync(1000);
    session.events.emit('stats', {
      ...STATS,
      bytesIn: 3000,
      creditReturned: 3000,
      droppedSamples: 40,
    });

    expect(session.calls).toHaveLength(2);
  });

  test('while a retry waits, plans again for an overspent budget only once it lasted', async () => {
    planner.close();
    planner = new StreamPlanner(session, {
      debounceMs: 10,
      retryMs: 60_000,
      now: () => Date.now(),
    });
    session.answer = () => Promise.reject(new Error('No answer'));
    const tick = unmeteredTicks();
    planner.request([{ variable: 'a', rateHz: 8000 }]);
    await vi.advanceTimersByTimeAsync(20);
    tick(0);
    tick(0);

    tick(6000);
    tick(0);
    tick(0);
    expect(session.calls).toHaveLength(1);

    for (let second = 0; second < 5; second++) {
      tick(6000);
    }

    expect(session.calls).toHaveLength(2);
  });

  test('falls back to gaps once the epoch carrying the drop counter ends', async () => {
    planner.request([
      { variable: 'a', rateHz: 100 },
      { variable: 'c', rateHz: 1, pinned: true, countsDrops: true },
    ]);
    await vi.advanceTimersByTimeAsync(20);
    session.events.emit('epoch', epochOf(8, [2]));
    session.events.emit('sample', { epoch: 8, seq: 0, timeUs: 0, values: [0], missingBefore: 0 });
    session.events.emit('stats', STATS);
    session.events.emit('epochEnd', { epoch: epochOf(8, [2]), reason: 'redefined' });
    await vi.advanceTimersByTimeAsync(1000);
    session.events.emit('stats', {
      ...STATS,
      bytesIn: 3000,
      creditReturned: 3000,
      droppedSamples: 40,
    });

    expect(planner.budget.saturated).toBe(true);
  });

  test("reads the robot's drop counter from the samples of its epoch", async () => {
    planner.request([
      { variable: 'a', rateHz: 100 },
      { variable: 'c', rateHz: 1, pinned: true, countsDrops: true },
    ]);
    await vi.advanceTimersByTimeAsync(20);
    session.events.emit('epoch', epochOf(7, [2]));
    session.events.emit('sample', { epoch: 7, seq: 0, timeUs: 0, values: [0], missingBefore: 0 });
    session.events.emit('stats', STATS);
    await vi.advanceTimersByTimeAsync(1000);
    session.events.emit('sample', { epoch: 7, seq: 1, timeUs: 1, values: [5], missingBefore: 0 });
    session.events.emit('stats', { ...STATS, bytesIn: 3000, creditReturned: 3000 });

    expect(planner.budget.saturated).toBe(true);
  });

  test('leaves the robot alone while the unmetered traffic only spikes for a moment', async () => {
    const tick = unmeteredTicks();
    planner.request([{ variable: 'a', rateHz: 8000 }]);
    await vi.advanceTimersByTimeAsync(20);
    tick(0);
    tick(0);

    tick(6000);

    for (let second = 0; second < 10; second++) {
      tick(0);
    }

    expect(session.calls).toHaveLength(1);
  });

  test('plans again once the budget stayed below the plan for the settle time, and only once', async () => {
    const tick = unmeteredTicks();
    planner.request([{ variable: 'a', rateHz: 8000 }]);
    await vi.advanceTimersByTimeAsync(20);
    tick(0);
    tick(0);

    tick(6000);
    tick(6000);
    tick(6000);
    expect(session.calls).toHaveLength(1);

    for (let second = 0; second < 10; second++) {
      tick(6000);
    }

    expect(session.calls).toHaveLength(2);
    expect(planner.plan?.budgetBytesPerSecond).toBeLessThan(5000);
  });
});

/**
 * Feeds the planner one stats event a second, with as many bytes arriving that the credit does
 * not meter as asked.
 */
function unmeteredTicks(): (unmeteredBytes: number) => void {
  let bytesIn = 0;
  let creditReturned = 0;

  return (unmeteredBytes) => {
    bytesIn += 10_000;
    creditReturned += 10_000 - unmeteredBytes;
    session.events.emit('stats', { ...STATS, bytesIn, creditReturned });
    vi.advanceTimersByTime(1000);
  };
}
