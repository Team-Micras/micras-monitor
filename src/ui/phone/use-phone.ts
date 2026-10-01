import { useSyncExternalStore } from 'react';

/** The width below which the app draws the phone view instead of the tiling, in CSS pixels. */
export const PHONE_MAX_WIDTH_PX = 640;

const QUERY = `(max-width: ${PHONE_MAX_WIDTH_PX - 1}px)`;

function subscribe(listener: () => void): () => void {
  const query = globalThis.matchMedia?.(QUERY);
  query?.addEventListener('change', listener);
  return () => query?.removeEventListener('change', listener);
}

/** Whether the window is narrow enough for the phone view, following resizes and rotation. */
export function usePhone(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => globalThis.matchMedia?.(QUERY).matches ?? false,
    () => false
  );
}
