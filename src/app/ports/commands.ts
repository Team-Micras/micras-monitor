/**
 * The port the shell sends robot commands through.
 *
 * @module
 */

/**
 * How a command ended. The robot's own answers carry the reason byte of COMMAND_ACK, which the
 * robot package names; `failed` is a command that got no answer, such as with no connection.
 */
export type CommandOutcome =
  | {
      readonly status: 'ok' | 'unknown' | 'refused' | 'deferred';
      readonly reason: number | null;
    }
  | { readonly status: 'failed'; readonly message: string };

/** Sends commands to the connected robot. */
export interface CommandPort {
  /**
   * Sends a command and waits for the robot's answer.
   *
   * @param code The command's code.
   * @param argument Its argument, 0 when omitted.
   */
  send(code: number, argument?: number): Promise<CommandOutcome>;
}
