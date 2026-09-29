import { useConnectionStatus, useRobotPackage } from '../monitor-context';
import { ConnectionPopover } from './connection-popover';
import { LayoutsMenu } from './layouts-menu';
import { SessionClock } from './session-clock';
import { StopButton } from './stop-button';
import { WorkspaceTabs } from './workspace-tabs';

/** The bar above the tiling: robot and connection, workspaces, clock and STOP. */
export function TopBar({ onStop }: { readonly onStop: () => void }) {
  const selection = useRobotPackage();
  const status = useConnectionStatus();
  const robotName = status.kind === 'linked' ? status.robot.name : null;

  return (
    <header className="grid h-16 shrink-0 grid-cols-[1fr_auto_1fr] items-center gap-4 px-3.5">
      <div className="flex min-w-0 items-center gap-3">
        <img src={`${import.meta.env.BASE_URL}micras_monitor_logo.svg`} alt="" className="size-7" />
        <span className="font-semibold tracking-tight">
          {selection?.package.displayName ?? robotName ?? 'Monitor'}
        </span>
        <ConnectionPopover />
      </div>
      <WorkspaceTabs />
      <div className="flex items-center justify-end gap-4">
        <LayoutsMenu />
        <SessionClock />
        <StopButton onStop={onStop} />
      </div>
    </header>
  );
}
