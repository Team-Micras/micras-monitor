import { useEffect, useState } from 'react';

import { Button } from '../components/ui/button';

/** The event Vite fires on `window` when a code-split chunk or its dependencies fail to load. */
export const PRELOAD_ERROR_EVENT = 'vite:preloadError';

/**
 * The notice that part of the app could not load, shown when a chunk fails to load
 * because the build it belongs to is gone from the server.
 */
export function UpdateNotice() {
  const [stale, setStale] = useState(false);

  useEffect(() => {
    const onError = () => setStale(true);
    window.addEventListener(PRELOAD_ERROR_EVENT, onError);
    return () => window.removeEventListener(PRELOAD_ERROR_EVENT, onError);
  }, []);

  if (!stale) {
    return null;
  }

  return (
    <output
      aria-label="Part of the app failed to load"
      className="fixed right-4 bottom-14 z-50 flex items-center gap-3 rounded-xl border bg-popover py-1.5 pr-1.5 pl-4 text-sm text-popover-foreground shadow-md"
    >
      <span>Couldn&apos;t load part of the app</span>
      <Button variant="outline" size="sm" onClick={() => location.reload()}>
        Reload
      </Button>
    </output>
  );
}
