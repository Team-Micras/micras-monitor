/**
 * The app on a desktop of the test's choosing, for browser tests of the shell: its tiling, menus,
 * tabs and keys. The demo robot stays disconnected unless the test connects it.
 *
 * @module
 */

import { render } from 'vitest-browser-react';

import { RobotRegistry } from '@/robot-kit';
import { mouse } from '@tests/support/robot-kit/packages';
import { activeWorkspace, createDesktop, leafIds, type Workspace } from '@/tiling';

import { App } from '@/app/app';
import type { LayoutStorage } from '@/app/layouts/layout-book';
import type { AppMonitor } from '@/app/monitor-context';
import { createShellStore, type ShellStore } from '@/app/state/shell-store';
import type { ShellWindow } from '@/app/windows/types';
import { settled } from '@tests/support/app/animations';
import { demoMonitor } from '@tests/support/sources/demo-monitor';

/** The app as mounted, with its store and live monitor. */
export interface ShellApp {
  readonly store: ShellStore;
  readonly monitor: AppMonitor;
  readonly screen: Awaited<ReturnType<typeof render>>;
}

/** A window of a kind showing some variables. */
export function shellWindow(
  id: string,
  kind: string,
  variables: readonly string[] = []
): ShellWindow {
  return { id, kind, payload: { variables } };
}

/**
 * Mounts the app on these workspaces and windows, the first workspace shown, and waits for it to
 * settle.
 */
export async function mountShell(
  workspaces: readonly Workspace[],
  windows: readonly ShellWindow[],
  layouts?: LayoutStorage
): Promise<ShellApp> {
  const monitor = demoMonitor();
  const store = createShellStore({ theme: 'dark', desktop: createDesktop(workspaces, windows) });
  const screen = await render(
    <App
      monitor={monitor}
      robots={new RobotRegistry([mouse({ id: 'micras' })])}
      store={store}
      layouts={layouts}
      synthetic
    />
  );
  await settled();
  return { store, monitor, screen };
}

/** The tiled windows of a workspace, the one shown by default, in tree order. */
export function tiledIds(store: ShellStore, workspace = store.getState().desktop.active): string[] {
  return leafIds(store.getState().desktop.workspaces[workspace].root);
}

/** The names of the workspaces, in order. */
export function workspaceNames(store: ShellStore): string[] {
  return store.getState().desktop.workspaces.map((workspace) => workspace.name);
}

/** The shown workspace. */
export function shownWorkspace(store: ShellStore): Workspace {
  return activeWorkspace(store.getState().desktop);
}
