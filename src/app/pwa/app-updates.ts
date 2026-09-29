/**
 * Whether a new build of the app is waiting, and the action that switches to it. The app never
 * reloads by itself: it only says that an update is waiting and lets the user apply it.
 *
 * @module
 */

/** A source of app updates, such as the service worker. */
export interface AppUpdates {
  /** Whether a new build is downloaded and waiting to take over. */
  readonly waiting: () => boolean;
  /** Calls `listener` after `waiting` changes; returns the function that stops it. */
  readonly subscribe: (listener: () => void) => () => void;
  /** Activates the waiting build and reloads the page onto it. */
  readonly apply: () => void;
}

/** What the service worker registration gives: a callback for a waiting build, and its activation. */
export interface RegisterServiceWorker {
  (options: { onNeedRefresh: () => void }): (reload: boolean) => Promise<void>;
}

/**
 * Follows the service worker for a waiting build.
 *
 * @param register Registers the service worker, as `registerSW` of `virtual:pwa-register` does.
 */
export function serviceWorkerUpdates(register: RegisterServiceWorker): AppUpdates {
  const listeners = new Set<() => void>();
  let waiting = false;
  const activate = register({
    onNeedRefresh: () => {
      waiting = true;
      listeners.forEach((listener) => listener());
    },
  });

  return {
    waiting: () => waiting,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    apply: () => void activate(true),
  };
}
