import { useEffect, useEffectEvent, useState } from 'react';

import { useConnectionStatus, useRobotPackage, useVariables } from '../monitor-context';
import { useShellStore } from '../state/shell-store';
import { LayoutBook, type LayoutStorage } from './layout-book';
import { layoutKey } from './layout-key';
import { LayoutSession } from './layout-session';

/**
 * Keeps the desktop and the layouts saved per robot in step: when a link comes up past its
 * schema, shows that robot's saved layout, or its initial one the first time; changes are saved
 * as they happen, and the last is saved when the page is left.
 *
 * @param storage Where the layouts are kept; without one the desktop is left alone.
 */
export function useLayouts(storage: LayoutStorage | null): void {
  const store = useShellStore();
  const status = useConnectionStatus();
  const variables = useVariables();
  const selection = useRobotPackage();
  const [session] = useState(() =>
    storage === null ? null : new LayoutSession(store, new LayoutBook(storage))
  );
  const key =
    status.kind === 'linked' && status.phase !== 'schema'
      ? layoutKey({
          packageId: selection?.package.id ?? null,
          name: status.robot.name,
          variables: variables.map(({ name }) => name),
        })
      : null;

  const follow = useEffectEvent((next: string) =>
    session?.follow({
      key: next,
      variables,
      packagePresets: selection?.package.presets ?? [],
    })
  );

  useEffect(() => {
    if (session === null) {
      return undefined;
    }

    session.start();
    const flush = () => session.flush();
    window.addEventListener('pagehide', flush);
    return () => {
      window.removeEventListener('pagehide', flush);
      session.stop();
    };
  }, [session]);

  useEffect(() => {
    if (key !== null) {
      follow(key);
    }
  }, [key]);
}
