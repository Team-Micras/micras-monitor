import { useMemo, type ReactNode } from 'react';

import { MonitorContext, useMonitor } from '../monitor-context';
import { useSessions } from './sessions-context';
import { savedSessionMonitor } from './view-ports';

/**
 * Shows the windows below it the saved session on screen, if there is one, instead of the live
 * one. The shell around them keeps the live connection, so STOP still reaches the robot.
 */
export function SessionView({ children }: { readonly children: ReactNode }) {
  const live = useMonitor();
  const viewing = useSessions()?.viewing ?? null;
  const monitor = useMemo(
    () => (viewing === null ? live : savedSessionMonitor(viewing, live.robots)),
    [live, viewing]
  );

  return <MonitorContext value={monitor}>{children}</MonitorContext>;
}
