/**
 * The end of the session's history, read a few times a second, for windows that judge how old a
 * value is.
 *
 * @module
 */

import { useSyncExternalStore } from 'react';

import { useConnectionStatus, useMonitor } from '../../monitor-context';

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
