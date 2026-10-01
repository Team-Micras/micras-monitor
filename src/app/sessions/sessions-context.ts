/**
 * The sessions of the app as React reads them.
 *
 * @module
 */

import { createContext, use, useSyncExternalStore } from 'react';

import type { StoreStatus, HistoryStore } from '@/history';

import type { SessionManager, SessionsState } from './session-manager';

/** Carries the app's {@link SessionManager}, or null where sessions are not kept. */
export const SessionsContext = createContext<SessionManager | null>(null);

/** The sessions manager, or null where sessions are not kept. */
export function useSessionManager(): SessionManager | null {
  return use(SessionsContext);
}

const noSubscription = () => () => undefined;
const noState = () => null;

/** The sessions' state, rendering again when it changes; null where sessions are not kept. */
export function useSessions(): SessionsState | null {
  const manager = useSessionManager();
  return useSyncExternalStore(
    manager === null ? noSubscription : (listener) => manager.subscribe(listener),
    manager === null ? noState : () => manager.state
  );
}

/** The memory and recording state of a store, rendering again when it changes. */
export function useStoreStatus(store: HistoryStore): StoreStatus {
  return useSyncExternalStore(
    (listener) => store.subscribeStatus(listener),
    () => store.status()
  );
}
