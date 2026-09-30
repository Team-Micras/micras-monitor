/**
 * The app on a desktop of the test's choosing, for browser tests of the shell: its tiling, menus,
 * tabs and keys. The demo robot stays disconnected unless the test connects it.
 *
 * @module
 */

import { render } from 'vitest-browser-react';

import { RobotRegistry } from '@/robot-kit';
import { mouse } from '@/robot-kit/fixtures/packages';
import { activeWorkspace, createDesktop, leafIds, type Workspace } from '@/tiling';

import { App } from '../app';
import { createDemoRobot } from '../fake/demo-robot';
import type { FakeRobot } from '../fake/fake-robot';
import type { LayoutStorage } from '../layouts/layout-book';
import { createShellStore, type ShellStore } from '../state/shell-store';
import type { ShellWindow } from '../windows/types';
import { settled } from './animations';

/** The app as mounted, with its store and robot. */
export interface ShellApp {
  readonly store: ShellStore;
  readonly robot: FakeRobot;
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
  const robot = createDemoRobot({ connectMs: 5, handshakeMs: 10, configureMs: 5 });
  const store = createShellStore({ theme: 'dark', desktop: createDesktop(workspaces, windows) });
  const screen = await render(
    <App
      ports={robot.ports}
      robots={new RobotRegistry([mouse({ id: 'micras' })])}
      store={store}
      layouts={layouts}
      synthetic
    />
  );
  await settled();
  return { store, robot, screen };
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
