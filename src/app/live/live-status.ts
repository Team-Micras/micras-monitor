/**
 * How the state of a transport and of the session over it read as the shell's connection status.
 *
 * @module
 */

import type { RobotInfo, SessionState, TransportState } from '@/link';

import type { ConnectionStatus, ConnectionTarget, LinkPhase } from '../ports';

/** Where a live connection is, as {@link connectionStatus} reads it. */
export interface LinkSnapshot {
  readonly target: ConnectionTarget;
  readonly transport: TransportState;
  readonly session: SessionState;
  readonly robot: RobotInfo | undefined;
  /** When the link last came up, in `Date.now()` milliseconds. */
  readonly since: number;
}

const PHASES: Partial<Record<SessionState['kind'], LinkPhase>> = {
  loadingSchema: 'schema',
  configuring: 'configuring',
  streaming: 'streaming',
};

/** The phase of a session whose link is up, or null while it is not. */
export function linkPhase(state: SessionState): LinkPhase | null {
  return PHASES[state.kind] ?? null;
}

function transportStatus(target: ConnectionTarget, state: TransportState): ConnectionStatus {
  if (state.kind !== 'closed' || state.retryInMs !== undefined) {
    return { kind: 'connecting', target };
  }

  switch (state.reason) {
    case 'needs-user-gesture':
      return { kind: 'failed', target, message: 'Click Connect to reach the robot again.' };
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
 * The connection status of a live link. A session that is up is `linked` in the phase it is in;
 * one that lost its transport is `connecting` while the transport retries and `failed` once it
 * gave up; a session in error is `failed` with the error's message.
 */
export function connectionStatus(link: LinkSnapshot): ConnectionStatus {
  const { target, session, robot } = link;
  const phase = linkPhase(session);

  if (phase !== null && robot !== undefined) {
    return {
      kind: 'linked',
      target,
      robot: { name: robot.robotName, schemaHash: robot.schemaHash },
      phase,
      since: link.since,
    };
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

/** Whether two statuses read the same, so the shell keeps the object it has. */
export function sameStatus(a: ConnectionStatus, b: ConnectionStatus): boolean {
  if (a.kind !== b.kind) {
    return false;
  }

  if (a.kind === 'linked' && b.kind === 'linked') {
    return (
      a.phase === b.phase &&
      a.since === b.since &&
      a.robot.name === b.robot.name &&
      a.robot.schemaHash === b.robot.schemaHash &&
      a.target === b.target
    );
  }

  if (a.kind === 'failed' && b.kind === 'failed') {
    return a.message === b.message && a.target === b.target;
  }

  return a.kind === 'disconnected' || ('target' in a && 'target' in b && a.target === b.target);
}
