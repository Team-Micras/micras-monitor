/**
 * Whether a new build of the app is waiting, and the action that switches to it. The app never
 * reloads by itself: it says that an update is waiting and lets the user apply it, and a tab
 * reloads only for an update that tab applied. When another tab applied it, the tab keeps
 * running its build and offers a reload of its own.
 *
 * @module
 */

/** A source of app updates, such as the service worker. */
export interface AppUpdates {
  /** Whether a new build is waiting, or already active and waiting for this tab to reload. */
  readonly waiting: () => boolean;
  /** Calls `listener` after `waiting` changes; returns the function that stops it. */
  readonly subscribe: (listener: () => void) => () => void;
  /** Switches to the new build and reloads the page onto it. */
  readonly apply: () => void;
}

/** What the service worker registration tells the app. */
export interface ServiceWorkerHooks {
  /** A new build is installed and waiting. */
  readonly onNeedRefresh: () => void;
  /** A new build took control of the page, whichever tab asked for it. */
  readonly onNeedReload: () => void;
}

/** Registers the service worker, as `registerSW` of `virtual:pwa-register` does. */
export type RegisterServiceWorker = (
  hooks: ServiceWorkerHooks
) => (reload: boolean) => Promise<void>;

/**
 * Follows the service worker for a waiting build.
 *
 * @param register Registers the service worker.
 * @param reload Reloads the page.
 */
export function serviceWorkerUpdates(
  register: RegisterServiceWorker,
  reload: () => void = () => location.reload()
): AppUpdates {
  const listeners = new Set<() => void>();
  let waiting = false;
  let applying = false;
  let active = false;
  const announce = () => {
    waiting = true;
    listeners.forEach((listener) => listener());
  };
  const activate = register({
    onNeedRefresh: announce,
    onNeedReload: () => {
      if (applying) {
        reload();
        return;
      }

      active = true;
      announce();
    },
  });

  return {
    waiting: () => waiting,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    apply: () => {
      if (active) {
        reload();
        return;
      }

      applying = true;
      void activate(true);
    },
  };
}
