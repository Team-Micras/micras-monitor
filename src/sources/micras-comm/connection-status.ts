/**
 * How the state of a transport and of the link over it read as a source's status.
 *
 * @module
 */

import type { SourceIdentity, SourceStatus, Target } from '@/core/source';

import type { RobotInfo, LinkState, TransportState } from './link';

/** Where a live connection is, as {@link connectionStatus} reads it. */
export interface LinkSnapshot {
  readonly target: Target;
  readonly transport: TransportState;
  readonly session: LinkState;
  readonly robot: RobotInfo | undefined;
  /** When the link last came up, in `Date.now()` milliseconds. */
  readonly since: number;
}

const UP_STATES: ReadonlySet<LinkState['kind']> = new Set([
  'loadingSchema',
  'configuring',
  'streaming',
]);

/** Whether a link is up: the robot said who it is and takes commands. */
export function isLinkUp(state: LinkState): boolean {
  return UP_STATES.has(state.kind);
}

/** The identity of a robot as HELLO_ACK gave it, with its schema hash in hex. */
export function identityOf(robot: RobotInfo): SourceIdentity {
  return {
    name: robot.robotName,
    schema: (robot.schemaHash >>> 0).toString(16).padStart(8, '0'),
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

/**
 * The status of a live link. A link that is up is `linked`; one that lost its transport is
 * `connecting` while the transport retries and `failed` once it gave up; a link in error is
 * `failed` with the error's message.
 */
export function connectionStatus(link: LinkSnapshot): SourceStatus {
  const { target, session, robot } = link;

  if (isLinkUp(session) && robot !== undefined) {
    return { kind: 'linked', target, identity: identityOf(robot), since: link.since };
  }

  switch (session.kind) {
    case 'error':
      return { kind: 'failed', target, message: session.error.message };
    case 'closed':
      return { kind: 'disconnected' };
    case 'handshaking':
      return { kind: 'handshaking', target };
    default:
      return transportStatus(target, link.transport);
  }
}

/** Whether two statuses read the same, so the source does not report a change that is none. */
export function sameStatus(a: SourceStatus, b: SourceStatus): boolean {
  if (a.kind !== b.kind) {
    return false;
  }

  if (a.kind === 'linked' && b.kind === 'linked') {
    return (
      a.since === b.since &&
      a.identity.name === b.identity.name &&
      a.identity.schema === b.identity.schema &&
      a.target === b.target
    );
  }

  if (a.kind === 'failed' && b.kind === 'failed') {
    return a.message === b.message && a.target === b.target;
  }

  return a.kind === 'disconnected' || ('target' in a && 'target' in b && a.target === b.target);
}
