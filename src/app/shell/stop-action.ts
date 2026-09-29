/**
 * The shell's emergency stop, for windows that draw a STOP of their own: every STOP goes through
 * the same action as the top bar's button and the keyboard, with the same notice.
 *
 * @module
 */

import { createContext, use } from 'react';

/** Sends the robot package's emergency command and shows how it went. */
export type StopAction = () => void;

/** Carries the shell's stop action to the windows. */
export const StopActionContext = createContext<StopAction | null>(null);

/**
 * The shell's stop action.
 *
 * @throws {Error} Outside of a `StopActionContext`.
 */
export function useStopAction(): StopAction {
  const stop = use(StopActionContext);

  if (stop === null) {
    throw new Error('useStopAction needs a StopActionContext above it');
  }

  return stop;
}
