/**
 * The sessions of the app as React reads them.
 *
 * @module
 */

import { createContext, use, useSyncExternalStore } from 'react';

import type { StoreStatus, HistoryStore } from '@/history';

import type { RecordingManager, RecordingsState } from '@/recording/library/recording-manager';

/** Carries the app's {@link RecordingManager}, or null where sessions are not kept. */
export const RecordingsContext = createContext<RecordingManager | null>(null);

/** The sessions manager, or null where sessions are not kept. */
export function useRecordingManager(): RecordingManager | null {
  return use(RecordingsContext);
}

const noSubscription = () => () => undefined;
const noState = () => null;

/** The sessions' state, rendering again when it changes; null where sessions are not kept. */
export function useRecordings(): RecordingsState | null {
  const manager = useRecordingManager();
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
