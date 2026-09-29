import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { decodeAccess, ErrorCode, TypeCode } from '../protocol';
import { Emitter } from './emitter';
import { RobotError, SessionError } from './errors';
import type { Epoch, GroupRequest } from './groups';
import type { SchemaEntry } from './schema';
import type { GroupsResult, LinkStats, RobotInfo, SessionEvents } from './session-types';
import { StreamPlanner, type PlannerSession } from './stream-planner';

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
});
