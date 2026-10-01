import { ErrorCode } from '../wire';

/** The robot answered a request with ERROR. */
export class RobotError extends Error {
  override readonly name = 'RobotError';
  /** Why the robot refused. */
  readonly code: ErrorCode;
  /** What identifies the refused request, such as a variable id. */
  readonly context: number;

  /**
   * @param code Why the robot refused.
   * @param context What identifies the refused request, such as a variable id.
   */
  constructor(code: ErrorCode, context: number) {
    super(`The robot refused the request: ${ErrorCode[code] ?? code} (${context})`);
    this.code = code;
    this.context = context;
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
export type LinkErrorReason =
  /** The link is not in a state that allows the request. */
  | 'not-ready'
  /** The transport dropped. */
  | 'disconnected'
  /** The link restarted its handshake, which resets what the request depended on. */
  | 'restarted'
  /** A later call replaced this one. */
  | 'superseded'
  /** The link was closed. */
  | 'closed';

/** A request ended because of what happened to the link, not because of the robot. */
export class LinkError extends Error {
  override readonly name = 'LinkError';
  readonly reason: LinkErrorReason;

  /**
   * @param reason Why the request ended.
   * @param message What to tell, the reason by default.
   */
  constructor(reason: LinkErrorReason, message: string = reason) {
    super(message);
    this.reason = reason;
  }
}

/**
 * Turn anything thrown into an `Error`.
 *
 * @param error Whatever was thrown.
 * @returns It, or an `Error` describing it.
 */
export function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
