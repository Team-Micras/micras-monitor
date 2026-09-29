/**
 * The port that writes the robot's variables. A write is pending until the robot answers it:
 * only the answer tells whether the value took, so the windows never show a pending value as
 * the robot's.
 *
 * @module
 */

/** A value a variable can be written with, by its type. */
export type WriteValue = number | boolean | bigint;

/** Why the robot refused a write, as the status of WRITE_ACK. */
export type WriteRefusal = 'no-such-variable' | 'read-only' | 'needs-idle' | 'wrong-size';

/**
 * How a write ended: the robot took the value, refused it, a newer write of the same variable
 * replaced it before it was sent, or it got no answer, such as with no connection.
 */
export type WriteOutcome =
  | { readonly status: 'confirmed' }
  | { readonly status: 'refused'; readonly reason: WriteRefusal }
  | { readonly status: 'superseded' }
  | { readonly status: 'failed'; readonly message: string };

/** Writes the robot's variables, at most one write in flight per variable. */
export interface WritePort {
  /**
   * Writes a variable and waits for the robot's answer.
   *
   * @param name The variable, by name.
   * @param value The value, already checked against the variable's type.
   */
  write(name: string, value: WriteValue): Promise<WriteOutcome>;

  /** The newest value written to a variable that the robot has not answered yet. */
  pending(name: string): WriteValue | undefined;

  /** Calls `listener` after a write starts or ends; returns the function that stops it. */
  subscribe(listener: () => void): () => void;
}
