import { useMemo, type ReactNode } from 'react';

import { Monitor } from '@/core/monitor';

import { MonitorContext, useMonitorScope } from '../monitor-context';
import { useSessions } from './sessions-context';

/**
 * Shows the windows below it the saved session on screen, if there is one, instead of the live
 * robot: a monitor over the session's history, with no connection. The live monitor stays what
 * the shell around them acts on.
 */
export function SessionView({ children }: { readonly children: ReactNode }) {
  const scope = useMonitorScope();
  const viewing = useSessions()?.viewing ?? null;
  const shown = useMemo(
    () =>
      viewing === null
        ? scope
        : {
            ...scope,
            shown: Monitor.ofRecording(
              viewing.store,
              { name: viewing.robot, schema: null },
              viewing.variables
            ),
            recording: viewing.session.name,
          },
    [scope, viewing]
  );

  return <MonitorContext value={shown}>{children}</MonitorContext>;
}
