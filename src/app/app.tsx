import { useEffect, useState, type ReactNode } from 'react';

import type { RobotRegistry } from '@/robot-kit';
import { emergencyCommand } from '@/robot-kit';
import { activeWorkspace, focusedWindow } from '@/tiling';

import { TooltipProvider } from './components/ui/tooltip';
import type { KeyAction } from './keymap/keymap';
import { tilingCommandFor } from './keymap/tiling-commands';
import { useKeymap } from './keymap/use-keymap';
import { MonitorContext, useMonitor, useRobotPackage } from './monitor-context';
import type { MonitorPorts } from './ports';
import { Launcher } from './shell/launcher';
import { StatusBar } from './shell/status-bar';
import { TopBar } from './shell/top-bar';
import { VariableDrawer } from './shell/variable-drawer';
import {
  createShellStore,
  ShellStoreContext,
  useShell,
  useShellStore,
  type ShellStore,
} from './state/shell-store';
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
}

/** The monitor: top bar, tiling of workspaces, status bar, drawer and launcher. */
export function App({ ports, robots, synthetic = false, store: given }: AppProps) {
  const [store] = useState(() => given ?? createShellStore({ theme: initialTheme() }));

  return (
    <MonitorContext value={{ ports, robots, synthetic }}>
      <ShellStoreContext value={store}>
        <TooltipProvider>
          <Shell />
        </TooltipProvider>
      </ShellStoreContext>
    </MonitorContext>
  );
}

function Shell() {
  const store = useShellStore();
  const { ports } = useMonitor();
  const selection = useRobotPackage();
  const theme = useShell((state) => state.theme);
  const bindings = useShell((state) => state.bindings);
  const drawerOpen = useShell((state) => state.overlay === 'drawer');

  useEffect(() => applyTheme(theme), [theme]);

  const stop = () => {
    const command = emergencyCommand(selection?.package ?? null);

    if (command !== null && ports.connection.status().kind === 'streaming') {
      void ports.commands.send(command.code);
    }
  };

  const onAction = (action: KeyAction) => {
    const state = store.getState();
    const command = tilingCommandFor<WindowPayload>(action, state.desktop.workspaces.length);

    if (command !== null) {
      state.run(command);
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
        stop();
        return;
      default:
        return;
    }
  };

  useKeymap(bindings, onAction);

  return (
    <div className="flex h-svh flex-col overflow-hidden bg-desktop text-foreground">
      <TopBar onStop={stop} />
      <main className="relative min-h-0 flex-1">
        <TilingView />
        {drawerOpen ? <VariableDrawer /> : null}
      </main>
      <StatusBar />
      <Launcher onAction={onAction} />
      <DragGhost />
    </div>
  );
}
