import { ErrorCode } from '../protocol';

/** The robot answered a request with ERROR. */
export class RobotError extends Error {
  override readonly name = 'RobotError';

  /**
   * @param code Why the robot refused.
   * @param context What identifies the refused request, such as a variable id.
   */
  constructor(
    readonly code: ErrorCode,
    readonly context: number
  ) {
    super(`The robot refused the request: ${ErrorCode[code] ?? code} (${context})`);
  }
}

/** The robot did not answer in time. */
export class TimeoutError extends Error {
  override readonly name = 'TimeoutError';

  constructor(what: string, timeoutMs: number) {
    super(`No answer to ${what} within ${timeoutMs} ms`);
  }
}

/** Why a request ended without an answer from the robot. */
export type SessionErrorReason =
  /** The session is not in a state that allows the request. */
  | 'not-ready'
  /** The transport dropped. */
  | 'disconnected'
  /** The session restarted its handshake, which resets what the request depended on. */
  | 'restarted'
  /** A later call replaced this one. */
  | 'superseded'
  /** The session was closed. */
  | 'closed';

/** A request ended because of what happened to the session, not because of the robot. */
export class SessionError extends Error {
  override readonly name = 'SessionError';

  constructor(
    readonly reason: SessionErrorReason,
    message: string = reason
  ) {
    super(message);
  }
}
