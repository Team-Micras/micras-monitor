/**
 * The end of the session's history, read a few times a second, and how old a value may get at
 * the rate it streams at, for windows that judge whether a value is stale.
 *
 * @module
 */

import { useSyncExternalStore } from 'react';

import type { MonitorState } from '@/core/monitor';

import { useMonitorState, type AppMonitor } from '../../monitor-context';
import { staleAfterUs } from './value-text';

/** How often the end of the session is read again. */
export const SESSION_END_INTERVAL_MS = 500;

function subscribeInterval(listener: () => void): () => void {
  const timer = setInterval(listener, SESSION_END_INTERVAL_MS);
  return () => clearInterval(timer);
}

/** The end of a monitor's history on its timeline, or undefined before the first sample. */
export function useSessionEnd(monitor: AppMonitor): number | undefined {
  const { history } = monitor;
  return useSyncExternalStore(subscribeInterval, () => history.timeRange()?.endUs);
}

/**
 * Whether a monitor's robot is linked with its variables known, so values keep arriving or are
 * about to again.
 */
export function useLinkLive(monitor: AppMonitor): boolean {
  return useMonitorState(
    monitor,
    (state) => state.status.kind === 'linked' && state.variables.length > 0
  );
}

/** The rate the source granted a variable, by name, or zero when it does not stream it. */
export function grantedRate(state: MonitorState, name: string): number {
  const id = state.variables.find((variable) => variable.name === name)?.id;
  return state.stats.streams.find((stream) => stream.variableId === id)?.grantedHz ?? 0;
}

/**
 * How old a variable's sample may get before it is stale: by the rate the source granted it,
 * or by the rate the window asks for when the source does not stream it yet.
 *
 * @param monitor The monitor that shows the variable.
 * @param name The variable, or null for none.
 * @param askedHz The rate the window asks for.
 */
export function useStaleAfter(monitor: AppMonitor, name: string | null, askedHz: number): number {
  return useMonitorState(monitor, (state) => {
    const granted = name === null ? 0 : grantedRate(state, name);
    return staleAfterUs(granted > 0 ? granted : askedHz);
  });
}
