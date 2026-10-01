import { useLiveMonitor, useRobotPackage, useStatus } from '../monitor-context';
import { RecordingControls } from '../sessions/recording-controls';
import { ViewingIndicator } from '../sessions/viewing-indicator';
import { ConnectionPopover } from './connection-popover';
import { LayoutsMenu } from './layouts-menu';
import { PinnedCommands } from './pinned-commands';
import { SessionClock } from './session-clock';
import { WorkspaceTabs } from './workspace-tabs';

/**
 * The bar above the tiling: robot and connection, the saved session on screen, workspaces,
 * clock, REC and the robot package's pinned commands.
 */
export function TopBar() {
  const monitor = useLiveMonitor();
  const selection = useRobotPackage(monitor);
  const status = useStatus(monitor);
  const robotName = status.kind === 'linked' ? status.identity.name : null;

  return (
    <header className="grid h-16 shrink-0 grid-cols-[1fr_auto_1fr] items-center gap-4 px-3.5">
      <div className="flex min-w-0 items-center gap-3">
        <img src={`${import.meta.env.BASE_URL}micras_monitor_logo.svg`} alt="" className="size-7" />
        <span className="font-semibold tracking-tight">
          {selection?.package.displayName ?? robotName ?? 'Monitor'}
        </span>
        <ConnectionPopover />
        <ViewingIndicator />
      </div>
      <WorkspaceTabs />
      <div className="flex items-center justify-end gap-4">
        <LayoutsMenu />
        <SessionClock />
        <RecordingControls />
        <PinnedCommands size="bar" />
      </div>
    </header>
  );
}
