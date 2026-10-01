/**
 * How the shell sends a command of the live robot: the pinned buttons, the command keys and the
 * pinned commands of a window all go through it, so they reach the live robot whatever is on
 * screen, ask first when the command has a confirmation, and share one notice.
 *
 * @module
 */

import { createContext, use } from 'react';

import type { CommandSpec } from '@/core/robot';

/**
 * Sends a command, after asking when it has a confirmation. By default it goes to the live robot
 * and the shell shows how it went; `run` takes over what happens once the command is confirmed,
 * for a window that sends it to the monitor it shows and reports the answer itself.
 */
export type SendCommand = (command: CommandSpec, run?: (command: CommandSpec) => void) => void;

/** Carries the shell's way to send a command to the windows and the bars. */
export const SendCommandContext = createContext<SendCommand | null>(null);

/**
 * The shell's way to send a command.
 *
 * @throws {Error} Outside of a `SendCommandContext`.
 */
export function useSendCommand(): SendCommand {
  const send = use(SendCommandContext);

  if (send === null) {
    throw new Error('useSendCommand needs a SendCommandContext above it');
  }

  return send;
}
