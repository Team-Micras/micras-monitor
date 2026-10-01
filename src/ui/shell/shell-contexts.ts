/**
 * The contexts the shell hands to the windows and the bars, so that they stay independent of the
 * shell's store: how to announce to screen readers, how to send a command of the live robot, and
 * how to tell the shell that a command waits for its answer.
 *
 * @module
 */

import { createContext, use } from 'react';

import type { CommandSpec } from '@/core/robot';
import type { WindowId } from '@/tiling';

/** How urgently a screen reader is told: after what it is saying, or at once. */
export type Politeness = 'polite' | 'assertive';

/** Says something to screen readers through the live regions of the `Announcer`. */
export type Announce = (text: string, politeness?: Politeness) => void;

/** Carries the announce function; announcing does nothing where there is no announcer. */
export const AnnounceContext = createContext<Announce>(() => undefined);

/** The function that announces to screen readers. */
export function useAnnounce(): Announce {
  return use(AnnounceContext);
}

/**
 * Sends a command, after asking when it has a confirmation. By default it goes to the live robot
 * and the shell shows how it went; `run` takes over what happens once the command is confirmed,
 * for a window that sends it to the monitor it shows and reports the answer itself. The pinned
 * buttons, the command keys and the pinned commands of a window all go through it, so they reach
 * the live robot whatever is on screen, ask first when the command has a confirmation, and share
 * one notice.
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

/**
 * Counts a window's command as sent (1) or answered (-1), so that closing the window can warn
 * that it waits for the robot's answer.
 */
export type CommandTracker = (id: WindowId, change: 1 | -1) => void;

/** Carries the tracker to the windows; without a shell, nothing is counted. */
export const CommandTrackerContext = createContext<CommandTracker>(() => undefined);

/** The tracker of the shell the window is in. */
export function useCommandTracker(): CommandTracker {
  return use(CommandTrackerContext);
}
