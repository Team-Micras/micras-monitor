import { useEffect, useState, useSyncExternalStore } from 'react';

import { Button } from '../components/ui/button';
import type { AppUpdates } from '../pwa/app-updates';
import type { ReloadBlock } from './reload-guard';

/** The event Vite fires on `window` when a code-split chunk or its dependencies fail to load. */
export const PRELOAD_ERROR_EVENT = 'vite:preloadError';

const NO_UPDATES: AppUpdates = {
  waiting: () => false,
  subscribe: () => () => undefined,
  apply: () => undefined,
};

/** What the notice is about. */
type Reason = 'update' | 'stale';

const RELOAD_BLOCKS: Readonly<Record<ReloadBlock, string>> = {
  recording: 'Stop recording to reload',
  disconnect: 'Disconnect to reload',
  'not-idle': 'Reload once the robot is idle',
};

/**
 * The notice that the app needs a reload: a new build is waiting, or part of the app could not
 * load because the build it belongs to is gone from the server. The page never reloads by itself,
 * and while a reload is blocked the button is disabled and the notice says what to do.
 *
 * @param updates Where new builds come from; none for an app without a service worker.
 * @param blockedBy Why a reload would cut a run or a recording short, or null when it would not.
 */
export function UpdateNotice({
  updates = NO_UPDATES,
  blockedBy = null,
}: {
  readonly updates?: AppUpdates;
  readonly blockedBy?: ReloadBlock | null;
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
      className="fixed right-4 bottom-14 z-50 max-sm:top-16 max-sm:bottom-auto flex max-w-[calc(100vw-2rem)] items-center gap-3 rounded-xl border bg-popover py-1.5 pr-1.5 pl-4 text-sm text-popover-foreground shadow-md"
    >
      <span>
        {reason === 'update' ? 'Update available' : "Couldn't load part of the app"}
        {blockedBy === null ? null : (
          <span className="block text-xs text-muted-foreground">{RELOAD_BLOCKS[blockedBy]}</span>
        )}
      </span>
      <Button variant="outline" size="sm" disabled={blockedBy !== null} onClick={reload}>
        Reload
      </Button>
    </output>
  );
}
