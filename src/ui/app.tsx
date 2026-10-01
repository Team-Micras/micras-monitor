import { useEffect, useRef, useState, type ReactNode } from 'react';

import type { CommandSpec, RobotRegistry } from '@/core/robot';
import type { SessionManager } from '@/recording/library/recording-manager';
import { activeWorkspace, focusedWindow } from '@/tiling';

import { initialKeyOverrides, saveKeyOverrides } from './keyboard/key-overrides';
import { actionFor, commandOf, type KeyAction } from './keyboard/keymap';
import { tilingCommandFor } from './keyboard/tiling-actions';
import { useKeymap } from './keyboard/use-keymap';
import type { LayoutStorage } from './layouts/saved-layouts';
import { useLayouts } from './layouts/use-layouts';
import { whenIdle } from './lazy/idle';
import { prefetchAll } from './lazy/lazy-with-retry';
import { commandAnswered, commandSent, noRobotFor, spaceUnbound } from './lib/command-outcome';
import { LazyPart } from './lib/lazy-part';
import { useEver } from './lib/use-ever';
import {
  MonitorContext,
  PackageChooser,
  useLiveMonitor,
  useRobotPackage,
  useStatus,
  useVariables,
  type AppMonitor,
  type MonitorScope,
} from './monitor-context';
import { phonePlan, planWindows } from './phone/phone-plan';
import { PhoneView } from './phone/phone-view';
import { usePhone } from './phone/use-phone';
import { TooltipProvider } from './primitives/tooltip';
import type { AppUpdates } from './pwa/app-updates';
import { SessionsContext } from './recordings/recordings-context';
import { SessionView } from './recordings/shown-monitor';
import { Announcements } from './shell/announcements';
import { Announcer } from './shell/announcer';
import { DRAWER_SEARCH_SELECTOR } from './shell/drawer-selector';
import {
  LazyCloseWorkspaceDialog,
  LazyLauncher,
  LazyUndoNotices,
  LazyVariableDrawer,
} from './shell/lazy-shell';
import { useReloadBlocked } from './shell/reload-guard';
import { SendCommandContext, type SendCommand } from './shell/send-command';
import { StatusBar } from './shell/status-bar';
import { TopBar } from './shell/top-bar';
import { UpdateNotice } from './shell/update-notice';
import {
  createShellStore,
  ShellStoreContext,
  useShell,
  useShellStore,
  type ShellStore,
} from './state/shell-store';
import { applyTheme, initialTheme } from './state/theme';
import { useStreamDemand } from './stream-demand';
import { DragGhost } from './tiling/drag-ghost';
import { TilingView } from './tiling/tiling-view';
import { LazyCommandConfirm } from './windows/commands/lazy-command-confirm';
import { CommandTrackerContext } from './windows/shared/command-tracker';
import type { WindowPayload } from './windows/types';

/** What the composition root gives the app. */
export interface AppProps {
  /** The live monitor, which every command goes to. */
  readonly monitor: AppMonitor;
  readonly robots: RobotRegistry<ReactNode>;
  /** Whether the monitor's data is synthetic, which the status bar then says. */
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
  /** The recorded and saved sessions; without it there is no REC. */
  readonly sessions?: SessionManager;
}

/** The monitor: top bar, tiling of workspaces, status bar, drawer and launcher. */
export function App({
  monitor,
  robots,
  synthetic = false,
  store: given,
  layouts,
  updates,
  sessions,
}: AppProps) {
  const [store] = useState(
    () => given ?? createShellStore({ theme: initialTheme(), keyOverrides: initialKeyOverrides() })
  );
  const [packages] = useState(() => new PackageChooser(robots));
  const [scope] = useState<MonitorScope>(() => ({
    live: monitor,
    shown: monitor,
    recording: null,
    packages,
    synthetic,
  }));

  return (
    <MonitorContext value={scope}>
      <SessionsContext value={sessions ?? null}>
        <ShellStoreContext value={store}>
          <TooltipProvider>
            <Announcer>
              <Shell layouts={layouts ?? null} updates={updates} />
            </Announcer>
          </TooltipProvider>
        </ShellStoreContext>
      </SessionsContext>
    </MonitorContext>
  );
}

interface PendingCommand {
  readonly command: CommandSpec;
  readonly run: (command: CommandSpec) => void;
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
  const live = useLiveMonitor();
  const theme = useShell((state) => state.theme);
  const bindings = useShell((state) => state.bindings);
  const keyOverrides = useShell((state) => state.keyOverrides);
  const drawerOpen = useShell((state) => state.overlay === 'drawer');
  const launcherOpen = useShell((state) => state.overlay === 'launcher');
  const launcherWanted = useEver(launcherOpen);
  const undoable = useShell(
    (state) => state.deletedPreset !== null || state.removedVariable !== null
  );
  const undoWanted = useEver(undoable);
  const closing = useShell((state) => state.closingWorkspace !== null);
  const closingAsked = useEver(closing);
  const presses = useRef(0);
  const [confirming, setConfirming] = useState<PendingCommand | null>(null);
  const [asking, setAsking] = useState(false);
  const [asks, setAsks] = useState(0);
  const askedOnce = useEver(asking);
  const phone = usePhone();
  const livePackage = useRobotPackage(live)?.package ?? null;
  const status = useStatus(live);
  const plan = phonePlan(livePackage, useVariables(live));
  const blockedBy = useReloadBlocked();

  useEffect(() => applyTheme(theme), [theme]);
  useEffect(() => whenIdle(() => void prefetchAll()), []);
  useEffect(() => saveKeyOverrides(keyOverrides), [keyOverrides]);
  useEffect(() => {
    if (livePackage !== null) {
      store.getState().setCommands(livePackage.commands);
    }
  }, [store, livePackage]);

  const send = async (wanted: CommandSpec) => {
    presses.current += 1;
    const id = presses.current;
    const { showCommandNotice } = store.getState();
    const pkg = livePackage;
    const command = pkg?.commands.find((known) => known.name === wanted.name);

    if (pkg === null || command === undefined) {
      showCommandNotice(noRobotFor(id, wanted));
      return;
    }

    showCommandNotice(commandSent(id, command));
    const outcome = await live.command(command.code, command.argument?.default);
    store.getState().showCommandNotice(commandAnswered(id, command, pkg, outcome));
  };

  const sendCommand: SendCommand = (command, run = (confirmed) => void send(confirmed)) => {
    if (command.confirm === undefined) {
      run(command);
    } else {
      setConfirming({ command, run });
      setAsks((count) => count + 1);
      setAsking(true);
    }
  };

  const confirmFailed = () => {
    presses.current += 1;
    setAsking(false);
    store.getState().showCommandNotice({
      id: presses.current,
      tone: 'error',
      text: "Couldn't open the confirmation — reload",
    });
  };

  const noCommandKey = () => {
    presses.current += 1;
    store.getState().showCommandNotice(spaceUnbound(presses.current, status.kind === 'linked'));
  };

  const sendByName = (name: string) => {
    const command = store.getState().commands.find((known) => known.name === name);

    if (command !== undefined) {
      sendCommand(command);
    }
  };

  const onAction = (action: KeyAction) => {
    const state = store.getState();
    const commandName = commandOf(action);

    if (commandName !== null) {
      sendByName(commandName);
      return;
    }

    const command = tilingCommandFor<WindowPayload>(
      action,
      state.desktop.workspaces.length,
      state.desktop.active
    );

    if (command !== null) {
      state.run(command);

      if (action.startsWith('focus.')) {
        focusWindowElement(store);
      } else if (action.startsWith('swap.') || action === 'window.close') {
        requestAnimationFrame(() => focusWindowElement(store));
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
      case 'workspace.close':
        state.requestCloseWorkspace(state.desktop.active, 'move');
        return;
      case 'launcher':
        state.setOverlay('launcher', true);
        return;
      case 'drawer':
        state.setOverlay('drawer', true);
        return;
      default:
        return;
    }
  };

  const onType = (event: KeyboardEvent) => {
    const search =
      drawerOpen && event.key !== '/' && actionFor(bindings, event) !== 'window.pause'
        ? document.querySelector(DRAWER_SEARCH_SELECTOR)
        : null;

    if (search instanceof HTMLInputElement) {
      search.focus();
      return true;
    }

    return false;
  };

  useKeymap(bindings, onAction, onType, noCommandKey);
  useStreamDemand(phone ? planWindows(plan) : null);
  useLayouts(layouts);

  return (
    <CommandTrackerContext value={store.getState().trackCommand}>
      <SendCommandContext value={sendCommand}>
        {phone ? (
          <PhoneView plan={plan} />
        ) : (
          <div className="flex h-svh flex-col overflow-hidden bg-desktop text-foreground">
            <TopBar />
            <SessionView>
              <main className="relative min-h-0 flex-1">
                <TilingView />
                {drawerOpen ? (
                  <LazyPart fallback={<DrawerFailed />} resetKey={drawerOpen} retryOnMount>
                    <LazyVariableDrawer />
                  </LazyPart>
                ) : null}
              </main>
            </SessionView>
            <StatusBar />
            {launcherWanted ? (
              <LazyPart fallback={null} resetKey={launcherOpen}>
                <LazyLauncher onAction={onAction} />
              </LazyPart>
            ) : null}
            <DragGhost />
          </div>
        )}
        <Announcements />
        {closingAsked ? (
          <LazyPart fallback={null} resetKey={closing}>
            <LazyCloseWorkspaceDialog />
          </LazyPart>
        ) : null}
        {undoWanted ? (
          <LazyPart fallback={null} resetKey={undoable}>
            <LazyUndoNotices />
          </LazyPart>
        ) : null}
        <UpdateNotice updates={updates} blockedBy={blockedBy} />
        {askedOnce ? (
          <LazyPart fallback={null} resetKey={asks} onError={confirmFailed}>
            <LazyCommandConfirm
              open={asking}
              command={confirming?.command ?? null}
              onOpenChange={setAsking}
              onConfirm={(command) => (confirming?.run ?? ((sent) => void send(sent)))(command)}
            />
          </LazyPart>
        ) : null}
      </SendCommandContext>
    </CommandTrackerContext>
  );
}
