/**
 * The end of the session's history, read a few times a second, and how old a value may get at
 * the rate it streams at, for windows that judge whether a value is stale.
 *
 * @module
 */

import { useSyncExternalStore } from 'react';

import { useConnectionStatus, useMonitor } from '../../monitor-context';
import type { LinkStats } from '../../ports';
import { staleAfterUs } from './readings';

/** How often the end of the session is read again. */
export const SESSION_END_INTERVAL_MS = 500;

function subscribeInterval(listener: () => void): () => void {
  const timer = setInterval(listener, SESSION_END_INTERVAL_MS);
  return () => clearInterval(timer);
}

/** The end of the session's history on its timeline, or undefined before the first sample. */
export function useSessionEnd(): number | undefined {
  const { history } = useMonitor().ports;
  return useSyncExternalStore(subscribeInterval, () => history.timeRange()?.endUs);
}

/** Whether the link is up past its schema, so values keep arriving or are about to again. */
export function useLinkLive(): boolean {
  const status = useConnectionStatus();
  return status.kind === 'linked' && status.phase !== 'schema';
}

/** The rate the stream planner granted a variable, or zero when it did not plan it. */
export function grantedRate(stats: LinkStats, name: string): number {
  return stats.budget.planned.find((stream) => stream.variable === name)?.grantedHz ?? 0;
}

/**
 * How old a variable's sample may get before it is stale: by the rate the planner granted it,
 * or by the rate the window asks for when the planner has not planned it.
 *
 * @param name The variable, or null for none.
 * @param askedHz The rate the window asks for.
 */
export function useStaleAfter(name: string | null, askedHz: number): number {
  const { link } = useMonitor().ports;
  return useSyncExternalStore(
    (listener) => link.subscribe(listener),
    () => {
      const granted = name === null ? 0 : grantedRate(link.stats(), name);
      return staleAfterUs(granted > 0 ? granted : askedHz);
    }
  );
}
