import { MoonIcon, SunIcon } from 'lucide-react';
import type { ReactNode } from 'react';

import { roleVariable } from '@/core/robot';

import { useLiveMonitor, useLiveValue, useRobotPackage, useStatus } from '../monitor-context';
import { Button } from '../primitives/button';
import { cn } from '../primitives/utils';
import { ConnectionPopover } from '../shell/bars/connection-popover';
import { PinnedCommands } from '../shell/commands/pinned-commands';
import { SessionClock } from '../shell/bars/session-clock';
import { useShell, useShellStore } from '../state/shell-store';
import { WindowErrorBoundary } from '../tiling/window-error-boundary';
import { CommandsWindow } from '../windows/commands/commands-window';
import { READOUT_RATE_HZ } from '../windows/stream-rates';
import { windowKind } from '../windows/registry';
import { usePresentedVariables } from '../windows/shared/presented-variables';
import { useLinkLive, useSessionEnd, useStaleAfter } from '../windows/shared/session-end';
import { formatReading, isStale } from '../windows/shared/value-text';
import type { ShellWindow } from '../windows/types';
import type { PhonePlan } from './phone-plan';

const TRANSPORT_WORDS = { websocket: 'WebSocket', bluetooth: 'Bluetooth' } as const;

function Card({
  label,
  className,
  children,
}: {
  readonly label?: string;
  readonly className?: string;
  readonly children: ReactNode;
}) {
  return (
    <section
      aria-label={label}
      className={cn(
        'shrink-0 overflow-hidden rounded-2xl border bg-card text-card-foreground',
        className
      )}
    >
      {children}
    </section>
  );
}

function Cell({
  label,
  className,
  children,
}: {
  readonly label: string;
  readonly className?: string;
  readonly children: ReactNode;
}) {
  return (
    <div className={cn('flex min-w-0 flex-col gap-1 px-4 py-3', className)}>
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="flex min-w-0 items-baseline gap-2 text-xl font-medium">{children}</dd>
    </div>
  );
}

function Status() {
  const monitor = useLiveMonitor();
  const status = useStatus(monitor);
  const selection = useRobotPackage(monitor);
  const pkg = selection?.package ?? null;
  const stateName = roleVariable(pkg, 'state');
  const batteryName = roleVariable(pkg, 'battery');
  const [state, battery] = usePresentedVariables(monitor, [stateName ?? '', batteryName ?? '']);
  const current = useLiveValue(monitor, stateName);
  const voltage = useLiveValue(monitor, batteryName);
  const sessionEndUs = useSessionEnd(monitor);
  const live = useLinkLive(monitor);
  const stateStaleAfterUs = useStaleAfter(monitor, stateName, READOUT_RATE_HZ);
  const batteryStaleAfterUs = useStaleAfter(monitor, batteryName, READOUT_RATE_HZ);
  const robot = status.kind === 'linked' ? status.identity.name : null;

  return (
    <Card label="Status">
      <dl className="grid grid-cols-2">
        <Cell label="Robot" className="border-r border-b">
          <span className="truncate">{pkg?.displayName ?? robot ?? '—'}</span>
          {robot === null ? null : (
            <span className="truncate font-mono text-sm font-normal text-muted-foreground">
              {robot}
            </span>
          )}
        </Cell>
        <Cell label="Link" className="border-b">
          {status.kind === 'disconnected' ? (
            '—'
          ) : (
            <span className="truncate">{TRANSPORT_WORDS[status.target.transport]}</span>
          )}
        </Cell>
        <Cell label="State" className="border-r">
          <span
            data-robot-state
            className={cn(
              'truncate font-mono',
              isStale(current, sessionEndUs, live, stateStaleAfterUs) && 'opacity-45'
            )}
          >
            {current === undefined
              ? '—'
              : formatReading(
                  current.value,
                  state?.presentation?.labels ?? null,
                  state?.variable?.type
                )}
          </span>
        </Cell>
        <Cell label="Battery">
          <span
            data-battery
            className={cn(
              'font-mono tabular-nums',
              isStale(voltage, sessionEndUs, live, batteryStaleAfterUs) && 'opacity-45'
            )}
          >
            {typeof voltage?.value === 'number' ? voltage.value.toFixed(2) : '—'}
          </span>
          {battery?.presentation?.unit == null ? null : (
            <span className="text-sm font-normal text-muted-foreground">
              {battery.presentation.unit}
            </span>
          )}
        </Cell>
      </dl>
    </Card>
  );
}

function Windowed({
  window,
  label,
  className,
}: {
  readonly window: ShellWindow;
  readonly label: string;
  readonly className: string;
}) {
  const View = windowKind(window.kind).component;

  return (
    <Card label={label} className={className}>
      <WindowErrorBoundary>
        <View window={window} paused={false} visible />
      </WindowErrorBoundary>
    </Card>
  );
}

function PhoneCommands() {
  return (
    <footer className="shrink-0 border-t bg-background px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
      <PinnedCommands size="phone" />
    </footer>
  );
}

function ThemeToggle() {
  const store = useShellStore();
  const theme = useShell((state) => state.theme);

  return (
    <Button
      variant="ghost"
      size="icon"
      className="size-12"
      aria-label={theme === 'dark' ? 'Use the light theme' : 'Use the dark theme'}
      onClick={() => store.getState().toggleTheme()}
    >
      {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
    </Button>
  );
}

/**
 * The phone's single column, from the plan: connection, status, the map, the values, the commands,
 * a small plot and the settings, above the pinned commands, such as STOP, that stay in reach. It
 * draws the windows of the plan, so what a robot shows on the phone is whatever the plan finds in
 * its package.
 */
export function PhoneView({ plan }: { readonly plan: PhonePlan }) {
  return (
    <div data-phone className="flex h-svh flex-col overflow-hidden bg-desktop text-foreground">
      <header className="flex h-14 shrink-0 items-center gap-2 px-4">
        <img
          src={`${import.meta.env.BASE_URL}micras_monitor_logo.svg`}
          alt=""
          className="size-8 shrink-0"
        />
        <ConnectionPopover />
        <span className="flex-1" />
        <SessionClock />
      </header>
      <main className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto overscroll-contain px-4 pb-4">
        <Status />
        {plan.maze === null ? null : (
          <Windowed window={plan.maze} label="Maze" className="aspect-square" />
        )}
        {plan.values === null ? null : (
          <Windowed window={plan.values} label="Values" className="shrink-0 py-2" />
        )}
        <Card label="Commands" className="pt-4">
          <CommandsWindow window={plan.commands} paused={false} visible showPinned={false} />
        </Card>
        {plan.plot === null ? null : <Windowed window={plan.plot} label="Plot" className="h-56" />}
        {plan.settings === null ? null : (
          <Windowed window={plan.settings} label="Run profile" className="pt-4" />
        )}
        <div className="flex shrink-0 justify-center">
          <ThemeToggle />
        </div>
      </main>
      <PhoneCommands />
    </div>
  );
}
