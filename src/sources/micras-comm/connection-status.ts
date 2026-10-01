/**
 * How the state of a transport and of the link over it read as a source's status, and the
 * counters of the link and its planner as the source's stats.
 *
 * @module
 */

import type { SourceIdentity, SourceStats, SourceStatus, Target } from '@/core/source';
import type { Variable } from '@/core/variables';

import type { LinkCounters, LinkState, RobotInfo } from './link/link-events';
import type { BudgetEstimate } from './streaming/bandwidth-estimator';
import type { StreamPlan } from './streaming/fit-groups';
import type { TransportState } from './transports/transport';

/** Where a link is, as far as the status of its connection goes. */
export type LinkPhase =
  /** The robot said who it is and takes commands. */
  | 'up'
  /** HELLO is out and the robot has not answered yet. */
  | 'handshaking'
  /** It stopped on what retrying cannot fix, such as another protocol version. */
  | 'failed'
  /** It was closed. */
  | 'closed'
  /** Its transport is not open, so the transport tells where the connection is. */
  | 'down';

/** Where a live connection is, as {@link connectionStatus} reads it. */
export interface LinkSnapshot {
  readonly target: Target;
  readonly transport: TransportState;
  readonly link: LinkState;
  readonly robot: RobotInfo | undefined;
  /** When the link last came up, in `Date.now()` milliseconds. */
  readonly since: number;
}

/** What {@link connectionStats} reads the stats from. */
export interface StatsSnapshot {
  readonly counters: LinkCounters;
  readonly budget: BudgetEstimate;
  readonly plan: StreamPlan | undefined;
  /** The robot's credit window, 0 before it said. */
  readonly creditWindow: number;
  /** The credit the robot last said it had left, if it streams it. */
  readonly creditLeft: number | undefined;
  readonly variables: readonly Variable[];
}

/** The phase a state of the link is in. */
export function phaseOf(state: LinkState): LinkPhase {
  switch (state.kind) {
    case 'loadingSchema':
    case 'configuring':
    case 'streaming':
      return 'up';
    case 'handshaking':
      return 'handshaking';
    case 'error':
      return 'failed';
    case 'closed':
      return 'closed';
    default:
      return 'down';
  }
}

/** The identity of a robot as HELLO_ACK gave it, with its schema hash in hex. */
export function identityOf(robot: RobotInfo): SourceIdentity {
  return {
    name: robot.robotName,
    schema: (robot.schemaHash >>> 0).toString(16).padStart(8, '0'),
  };
}

/**
 * The status of a live link. A link that is up is `linked`; one that lost its transport is
 * `connecting` while the transport retries and `failed` once it gave up; a link in error is
 * `failed` with the error's message.
 */
export function connectionStatus(snapshot: LinkSnapshot): SourceStatus {
  const { target, link, robot } = snapshot;

  switch (link.kind) {
    case 'error':
      return { kind: 'failed', target, message: link.error.message };
    case 'closed':
      return { kind: 'disconnected' };
    case 'handshaking':
      return { kind: 'handshaking', target };
    case 'disconnected':
      return transportStatus(target, snapshot.transport);
    default:
      return robot === undefined
        ? { kind: 'handshaking', target }
        : { kind: 'linked', target, identity: identityOf(robot), since: snapshot.since };
  }
}

/**
 * The stats of a connection: the link's counters, how full the robot's credit is, and what the
 * planner fits into the budget it estimates.
 */
export function connectionStats(snapshot: StatsSnapshot): SourceStats {
  const { counters, budget, plan, creditWindow, creditLeft } = snapshot;
  const ids = new Map(snapshot.variables.map((variable) => [variable.name, variable.id]));

  return {
    bytesInPerSecond: budget.bytesInPerSecond,
    rttMs: counters.rttMs ?? Number.NaN,
    samplesDropped: counters.droppedSamples,
    framesDiscarded: counters.framesDiscarded,
    gauges: [
      {
        label: 'Credit',
        used: creditLeft === undefined ? 0 : Math.max(0, creditWindow - creditLeft),
        capacity: creditWindow,
        unit: 'B',
        warn: false,
      },
      {
        label: 'Budget',
        used: plan?.usedBytesPerSecond ?? 0,
        capacity: budget.bytesPerSecond,
        unit: 'B/s',
        warn: plan?.overBudget ?? false,
      },
    ],
    streams: (plan?.rates ?? []).flatMap(({ variable, rateHz, grantedHz }) => {
      const variableId = ids.get(variable);
      return variableId === undefined ? [] : [{ variableId, askedHz: rateHz, grantedHz }];
    }),
  };
}

function transportStatus(target: Target, state: TransportState): SourceStatus {
  if (state.kind !== 'closed' || state.retryInMs !== undefined) {
    return { kind: 'connecting', target };
  }

  switch (state.reason) {
    case 'needs-user-gesture':
      return { kind: 'failed', target, message: 'Click Connect to reach the robot again.' };
    case 'taken-over':
      return {
        kind: 'failed',
        target,
        message: 'Another monitor took the link. Connect to take it back.',
      };
    case 'failed':
    case 'lost':
      return {
        kind: 'failed',
        target,
        message: state.error?.message ?? 'The connection to the robot failed.',
      };
    default:
      return { kind: 'connecting', target };
  }
}
