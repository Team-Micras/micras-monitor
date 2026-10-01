/**
 * How a window tells the shell that one of its commands waits for the robot's answer, so that
 * closing the window can warn about it. It is a context, so that the windows stay independent of
 * the shell's store.
 *
 * @module
 */

import { createContext, use } from 'react';

import type { WindowId } from '@/tiling';

/** Counts a window's command as sent (1) or answered (-1). */
export type CommandTracker = (id: WindowId, change: 1 | -1) => void;

/** Carries the tracker to the windows; without a shell, nothing is counted. */
export const CommandTrackerContext = createContext<CommandTracker>(() => undefined);

/** The tracker of the shell the window is in. */
export function useCommandTracker(): CommandTracker {
  return use(CommandTrackerContext);
}
