import { useEffect, useRef, useState, type ReactNode } from 'react';

import { whenIdle } from '@/lazy/idle';
import { prefetchAll } from '@/lazy/lazy-with-retry';
import type { RobotRegistry } from '@/robot-kit';
import { emergencyCommand } from '@/robot-kit';
import { activeWorkspace, focusedWindow } from '@/tiling';

import type { KeyAction } from './keymap/keymap';
import { tilingCommandFor } from './keymap/tiling-commands';
import { useKeymap } from './keymap/use-keymap';
import type { LayoutStorage } from './layouts/layout-book';
import { useLayouts } from './layouts/use-layouts';
import { TooltipProvider } from './components/ui/tooltip';
import { LazyPart } from './lib/lazy-part';
import { useEver } from './lib/use-ever';
import { nothingToStop, stopAnswered, stopSent } from './lib/stop-outcome';
import { MonitorContext, useMonitor, useRobotPackage, useVariables } from './monitor-context';
import { PackageSelector } from './package-selection';
import { phonePlan, planWindows } from './phone/phone-plan';
import { PhoneView } from './phone/phone-view';
import { usePhone } from './phone/use-phone';
import type { AppUpdates } from './pwa/app-updates';
import type { MonitorPorts } from './ports';
import { DeletedNotice } from './shell/deleted-notice';
import { DRAWER_SEARCH_SELECTOR } from './shell/drawer-selector';
import { LazyLauncher, LazyVariableDrawer } from './shell/lazy-shell';
import { useReloadBlocked } from './shell/reload-guard';
import { StatusBar } from './shell/status-bar';
import { StopActionContext } from './shell/stop-action';
import { TopBar } from './shell/top-bar';
import { UpdateNotice } from './shell/update-notice';
import { useStreamDemand } from './stream-demand';
import {
  createShellStore,
  ShellStoreContext,
  useShell,
  useShellStore,
  type ShellStore,
} from './state/shell-store';
import { initialKeyOverrides, saveKeyOverrides } from './state/key-overrides';
import { applyTheme, initialTheme } from './state/theme';
import { DragGhost } from './tiling/drag-ghost';
import { TilingView } from './tiling/tiling-view';
import type { WindowPayload } from './windows/types';

/** What the composition root gives the app. */
export interface AppProps {
  readonly ports: MonitorPorts;
  readonly robots: RobotRegistry<ReactNode>;
  /** Whether the ports serve synthetic data, which the status bar then says. */
  readonly synthetic?: boolean;
  /** The shell's state, for tests; a new store with the defaults otherwise. */
  readonly store?: ShellStore;
  /**
   * Where the layouts are kept per robot, such as `localStorage`. Without it the desktop is never
   * swapped for a robot's layout nor saved. Nothing coordinates two tabs: the last write wins.
   */
  readonly layouts?: LayoutStorage;
  /** Where new builds of the app come from, such as the service worker; none without one. */
  readonly updates?: AppUpdates;
}

/** The monitor: top bar, tiling of workspaces, status bar, drawer and launcher. */
export function App({
  ports,
  robots,
  synthetic = false,
  store: given,
  layouts,
  updates,
}: AppProps) {
  const [store] = useState(
    () => given ?? createShellStore({ theme: initialTheme(), keyOverrides: initialKeyOverrides() })
  );
  const [selection] = useState(() => new PackageSelector(ports.connection, ports.schema, robots));

  return (
    <MonitorContext value={{ ports, robots, selection, synthetic }}>
      <ShellStoreContext value={store}>
        <TooltipProvider>
          <Shell layouts={layouts ?? null} updates={updates} />
        </TooltipProvider>
      </ShellStoreContext>
    </MonitorContext>
  );
}

function DrawerFailed() {
  return (
    <div
      role="alert"
      className="absolute inset-y-0 left-0 z-30 flex w-72 items-center justify-center border-r bg-popover p-4 text-center text-sm text-muted-foreground"
    >
      Couldn&apos;t load the variables — close and open the drawer to try again
    </div>
  );
}

function focusWindowElement(store: ShellStore): void {
  const id = focusedWindow(activeWorkspace(store.getState().desktop));
  const element = id === null ? null : document.querySelector(`[data-window="${CSS.escape(id)}"]`);

  if (element instanceof HTMLElement) {
    element.focus({ preventScroll: true });
  }
}

function Shell({
  layouts,
  updates,
}: {
  readonly layouts: LayoutStorage | null;
  readonly updates: AppUpdates | undefined;
}) {
  const store = useShellStore();
  const { ports, selection } = useMonitor();
  const theme = useShell((state) => state.theme);
  const bindings = useShell((state) => state.bindings);
  const keyOverrides = useShell((state) => state.keyOverrides);
  const drawerOpen = useShell((state) => state.overlay === 'drawer');
  const launcherOpen = useShell((state) => state.overlay === 'launcher');
  const launcherWanted = useEver(launcherOpen);
  const presses = useRef(0);
  const phone = usePhone();
  const plan = phonePlan(useRobotPackage()?.package ?? null, useVariables());
  const blockedBy = useReloadBlocked();

  useEffect(() => applyTheme(theme), [theme]);
  useEffect(() => whenIdle(() => void prefetchAll()), []);
  useEffect(() => saveKeyOverrides(keyOverrides), [keyOverrides]);

  const stop = async () => {
    presses.current += 1;
    const id = presses.current;
    const { showStopNotice } = store.getState();
    const pkg = selection.current()?.package ?? null;
    const command = emergencyCommand(pkg);

    if (command === null) {
      showStopNotice(nothingToStop(id));
      return;
    }

    showStopNotice(stopSent(id, command));
    const outcome = await ports.commands.send(command.code).catch((error: unknown) => ({
      status: 'failed' as const,
      message: error instanceof Error ? error.message : String(error),
    }));
    store.getState().showStopNotice(stopAnswered(id, command, pkg, outcome));
  };

  const onAction = (action: KeyAction) => {
    const state = store.getState();
    const command = tilingCommandFor<WindowPayload>(action, state.desktop.workspaces.length);

    if (command !== null) {
      state.run(command);

      if (action.startsWith('focus.')) {
        focusWindowElement(store);
      }

      return;
    }

    switch (action) {
      case 'window.pause': {
        const focused = focusedWindow(activeWorkspace(state.desktop));

        if (focused !== null) {
          state.togglePause(focused);
        }

        return;
      }
      case 'launcher':
        state.setOverlay('launcher', true);
        return;
      case 'drawer':
        state.setOverlay('drawer', true);
        return;
      case 'stop':
        void stop();
        return;
      default:
        return;
    }
  };

  const onType = (event: KeyboardEvent) => {
    const search =
      drawerOpen && event.key !== '/' ? document.querySelector(DRAWER_SEARCH_SELECTOR) : null;

    if (search instanceof HTMLInputElement) {
      search.focus();
      return true;
    }

    return false;
  };

  useKeymap(bindings, onAction, onType);
  useStreamDemand(phone ? planWindows(plan) : null);
  useLayouts(layouts);

  return (
    <StopActionContext value={() => void stop()}>
      {phone ? (
        <PhoneView plan={plan} />
      ) : (
        <div className="flex h-svh flex-col overflow-hidden bg-desktop text-foreground">
          <TopBar onStop={() => void stop()} />
          <main className="relative min-h-0 flex-1">
            <TilingView />
            {drawerOpen ? (
              <LazyPart fallback={<DrawerFailed />} resetKey={drawerOpen} retryOnMount>
                <LazyVariableDrawer />
              </LazyPart>
            ) : null}
          </main>
          <StatusBar />
          {launcherWanted ? (
            <LazyPart fallback={null} resetKey={launcherOpen}>
              <LazyLauncher onAction={onAction} />
            </LazyPart>
          ) : null}
          <DragGhost />
        </div>
      )}
      <DeletedNotice />
      <UpdateNotice updates={updates} blockedBy={blockedBy} />
    </StopActionContext>
  );
}
