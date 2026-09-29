import { useEffect, useState, useSyncExternalStore } from 'react';

import { Button } from '../components/ui/button';
import type { AppUpdates } from '../pwa/app-updates';

/** The event Vite fires on `window` when a code-split chunk or its dependencies fail to load. */
export const PRELOAD_ERROR_EVENT = 'vite:preloadError';

const NO_UPDATES: AppUpdates = {
  waiting: () => false,
  subscribe: () => () => undefined,
  apply: () => undefined,
};

/** What the notice is about. */
type Reason = 'update' | 'stale';

/**
 * The notice that the app needs a reload: a new build is waiting, or part of the app could not
 * load because the build it belongs to is gone from the server. The page never reloads by itself,
 * and while `reloadBlocked` the button is disabled and the notice says to wait.
 *
 * @param updates Where new builds come from; none for an app without a service worker.
 * @param reloadBlocked Whether a reload would cut a run short.
 */
export function UpdateNotice({
  updates = NO_UPDATES,
  reloadBlocked = false,
}: {
  readonly updates?: AppUpdates;
  readonly reloadBlocked?: boolean;
}) {
  const [stale, setStale] = useState(false);
  const waiting = useSyncExternalStore(updates.subscribe, updates.waiting);

  useEffect(() => {
    const onError = () => setStale(true);
    window.addEventListener(PRELOAD_ERROR_EVENT, onError);
    return () => window.removeEventListener(PRELOAD_ERROR_EVENT, onError);
  }, []);

  const reason: Reason | null = waiting ? 'update' : stale ? 'stale' : null;

  if (reason === null) {
    return null;
  }

  const reload = () => (reason === 'update' ? updates.apply() : location.reload());

  return (
    <output
      aria-label={reason === 'update' ? 'Update available' : 'Part of the app failed to load'}
      className="fixed right-4 bottom-14 z-50 max-sm:bottom-28 flex max-w-[calc(100vw-2rem)] items-center gap-3 rounded-xl border bg-popover py-1.5 pr-1.5 pl-4 text-sm text-popover-foreground shadow-md"
    >
      <span>
        {reason === 'update' ? 'Update available' : "Couldn't load part of the app"}
        {reloadBlocked ? (
          <span className="block text-xs text-muted-foreground">Reload once the robot is idle</span>
        ) : null}
      </span>
      <Button variant="outline" size="sm" disabled={reloadBlocked} onClick={reload}>
        Reload
      </Button>
    </output>
  );
}
