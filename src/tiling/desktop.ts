/**
 * Operations on the whole desktop. Each takes a desktop and returns the next one; an operation
 * that does not apply returns the desktop it was given, so callers can compare by identity.
 *
 * @module
 */

import { clamp } from './geometry';
import { findNeighbour } from './focus';
import { fitFloating, layoutTree, layoutWorkspace } from './layout';
import { LayoutError } from './layout-error';
import { setRatioAt, swapLeaves } from './tree';
import type {
  Desktop,
  Direction,
  EdgePlacement,
  LayoutMetrics,
  NodePath,
  Rect,
  TilingWindow,
  WindowId,
  Workspace,
} from './types';
import { validateDesktop } from './validate';
import {
  addFloating,
  detach,
  dock,
  focusedWindow,
  holds,
  isFloating,
  isTiled,
  lift,
  tileBeside,
  tileByDwindle,
  withFocus,
} from './workspace';

/**
 * Creates a desktop from prebuilt workspaces and the windows they hold.
 *
 * @throws {LayoutError} When the workspaces and windows do not match, as {@link validateDesktop}
 *   describes.
 */
export function createDesktop<P>(
  workspaces: readonly Workspace[],
  windows: Iterable<TilingWindow<P>> = [],
  active = 0
): Desktop<P> {
  const list = [...windows];
  const repeated = list.findIndex((window, index) =>
    list.slice(0, index).some((other) => other.id === window.id)
  );

  if (repeated !== -1) {
    throw new LayoutError(`windows[${repeated}].id`, `repeats "${list[repeated].id}"`);
  }

  const desktop: Desktop<P> = {
    windows: new Map(list.map((window) => [window.id, window])),
    workspaces,
    active,
  };
  validateDesktop(desktop);
  return desktop;
}

/** The workspace on screen. */
export function activeWorkspace(desktop: Desktop): Workspace {
  return desktop.workspaces[desktop.active];
}

/** The index of the workspace holding a window, or -1. */
export function workspaceOf(desktop: Desktop, id: WindowId): number {
  return desktop.workspaces.findIndex((workspace) => holds(workspace, id));
}

function tiledWorkspaceOf(desktop: Desktop, id: WindowId): number {
  return desktop.workspaces.findIndex((workspace) => isTiled(workspace, id));
}

function updateWorkspace<P>(
  desktop: Desktop<P>,
  index: number,
  update: (workspace: Workspace) => Workspace
): Desktop<P> {
  const current = desktop.workspaces[index];
  const next = update(current);

  if (next === current) {
    return desktop;
  }

  return { ...desktop, workspaces: desktop.workspaces.map((ws, i) => (i === index ? next : ws)) };
}

/** Shows another workspace. An index that names no workspace changes nothing. */
export function switchWorkspace<P>(desktop: Desktop<P>, index: number): Desktop<P> {
  if (index === desktop.active || desktop.workspaces[index] === undefined) {
    return desktop;
  }

  return { ...desktop, active: index };
}

/**
 * Opens a window and focuses it. Without `at`, it goes to the active workspace by the dwindle
 * rule; with `at`, beside that tile, in the target's workspace, which is then shown. A target
 * that is not tiled anywhere falls back to the dwindle rule on the active workspace.
 *
 * @throws {LayoutError} When the id is empty or already open, or the kind is empty.
 */
export function openWindow<P>(
  desktop: Desktop<P>,
  window: TilingWindow<P>,
  metrics: LayoutMetrics,
  at?: EdgePlacement
): Desktop<P> {
  if (window.id === '') {
    throw new LayoutError('window.id', 'must be a non-empty string');
  }

  if (desktop.windows.has(window.id)) {
    throw new LayoutError('window.id', `"${window.id}" is already open`);
  }

  if (window.kind === '') {
    throw new LayoutError('window.kind', 'must be a non-empty string');
  }

  const target = at === undefined ? -1 : tiledWorkspaceOf(desktop, at.target);
  const index = target === -1 ? desktop.active : target;
  const opened = { ...desktop, windows: new Map(desktop.windows).set(window.id, window) };
  return updateWorkspace({ ...opened, active: index }, index, (workspace) =>
    at === undefined || target === -1
      ? tileByDwindle(workspace, window.id, metrics)
      : tileBeside(workspace, window.id, at)
  );
}

/**
 * Closes a window wherever it is. A tiled window's sibling takes its space; if it had the focus,
 * the previously focused window of its workspace gets it back.
 */
export function closeWindow<P>(desktop: Desktop<P>, id: WindowId): Desktop<P> {
  const index = workspaceOf(desktop, id);

  if (index === -1) {
    return desktop;
  }

  const windows = new Map(desktop.windows);
  windows.delete(id);
  return updateWorkspace({ ...desktop, windows }, index, (ws) => detach(ws, id).workspace);
}

/**
 * Focuses a window and shows its workspace. A floating window is raised; a tiled window hidden
 * behind a maximized one restores the tiling.
 */
export function focusWindow<P>(desktop: Desktop<P>, id: WindowId): Desktop<P> {
  const index = workspaceOf(desktop, id);

  if (index === -1) {
    return desktop;
  }

  return updateWorkspace(switchWorkspace(desktop, index), index, (ws) => withFocus(ws, id));
}

/** The visible window physically on one side of the focused one, as `findNeighbour` ranks it. */
export function neighbourOf(
  desktop: Desktop,
  direction: Direction,
  metrics: LayoutMetrics
): WindowId | null {
  const workspace = activeWorkspace(desktop);
  const focused = focusedWindow(workspace);

  if (focused === null) {
    return null;
  }

  const { windows } = layoutWorkspace(workspace, metrics);
  return findNeighbour(windows, focused, direction, workspace.focus);
}

/** Moves the focus to the window physically on one side of the focused one. */
export function focusDirection<P>(
  desktop: Desktop<P>,
  direction: Direction,
  metrics: LayoutMetrics
): Desktop<P> {
  const target = neighbourOf(desktop, direction, metrics);
  return target === null ? desktop : focusWindow(desktop, target);
}

/** Exchanges the tiles of two windows tiled in the same workspace; the focus does not move. */
export function swapWindows<P>(desktop: Desktop<P>, a: WindowId, b: WindowId): Desktop<P> {
  const index = tiledWorkspaceOf(desktop, a);

  if (index === -1 || index !== tiledWorkspaceOf(desktop, b)) {
    return desktop;
  }

  return updateWorkspace(desktop, index, (ws) =>
    ws.root === null ? ws : { ...ws, root: swapLeaves(ws.root, a, b) }
  );
}

/**
 * Swaps the focused tiled window with the visible tiled window on one side of it, found by the
 * edge rule. The focus stays on the window that moved.
 */
export function swapDirection<P>(
  desktop: Desktop<P>,
  direction: Direction,
  metrics: LayoutMetrics
): Desktop<P> {
  const workspace = activeWorkspace(desktop);
  const focused = focusedWindow(workspace);

  if (focused === null || !isTiled(workspace, focused)) {
    return desktop;
  }

  const tiled = layoutWorkspace(workspace, metrics).windows.filter((window) => !window.floating);
  const target = findNeighbour(tiled, focused, direction, workspace.focus);
  return target === null ? desktop : swapWindows(desktop, focused, target);
}

/**
 * Moves a window, tiled or floating, beside a tiled window, splitting that tile, and focuses it.
 * The target's workspace is shown. The window keeps its id, so views keyed by it stay mounted.
 */
export function moveWindow<P>(desktop: Desktop<P>, id: WindowId, at: EdgePlacement): Desktop<P> {
  const from = workspaceOf(desktop, id);
  const to = tiledWorkspaceOf(desktop, at.target);

  if (id === at.target || from === -1 || to === -1) {
    return desktop;
  }

  const detached = updateWorkspace(desktop, from, (ws) => detach(ws, id).workspace);
  return updateWorkspace({ ...detached, active: to }, to, (ws) => tileBeside(ws, id, at));
}

/**
 * Moves a window to another workspace, where it takes the focus. A tiled window is placed by the
 * dwindle rule; a floating one keeps its rect and forgets where it was tiled. The window keeps
 * its id.
 *
 * @param follow Whether to show the destination workspace.
 */
export function moveToWorkspace<P>(
  desktop: Desktop<P>,
  id: WindowId,
  index: number,
  metrics: LayoutMetrics,
  follow = true
): Desktop<P> {
  const from = workspaceOf(desktop, id);
  const destination = desktop.workspaces[index];

  if (from === -1 || from === index || destination === undefined) {
    return desktop;
  }

  const { workspace: source, floating } = detach(desktop.workspaces[from], id);
  const moved =
    floating === null
      ? tileByDwindle(destination, id, metrics)
      : addFloating(destination, { ...floating, dock: null });
  return {
    ...desktop,
    workspaces: desktop.workspaces.map((ws, i) => (i === from ? source : i === index ? moved : ws)),
    active: follow ? index : desktop.active,
  };
}

/** Maximizes the focused tiled window of the active workspace, or restores the tiling. */
export function toggleMaximize<P>(desktop: Desktop<P>): Desktop<P> {
  return updateWorkspace(desktop, desktop.active, (ws) => {
    if (ws.maximized !== null) {
      return { ...ws, maximized: null };
    }

    const focused = focusedWindow(ws);
    return focused !== null && isTiled(ws, focused) ? { ...ws, maximized: focused } : ws;
  });
}

/**
 * Lifts a tiled window into the floating layer, or docks a floating window back into the tiling
 * where it was when that place still exists, otherwise by the dwindle rule.
 */
export function toggleFloating<P>(
  desktop: Desktop<P>,
  id: WindowId,
  metrics: LayoutMetrics
): Desktop<P> {
  const index = workspaceOf(desktop, id);

  if (index === -1) {
    return desktop;
  }

  return updateWorkspace(desktop, index, (ws) =>
    isFloating(ws, id) ? dock(ws, id, metrics) : lift(ws, id, metrics)
  );
}

/**
 * Moves or resizes a floating window. The rect is fitted to the viewport: no smaller than the
 * minimum size where it fits, no larger than the usable bounds, and inside them.
 */
export function placeFloating<P>(
  desktop: Desktop<P>,
  id: WindowId,
  rect: Rect,
  metrics: LayoutMetrics
): Desktop<P> {
  const index = workspaceOf(desktop, id);

  if (index === -1) {
    return desktop;
  }

  const fitted = fitFloating(rect, metrics);
  return updateWorkspace(desktop, index, (ws) =>
    isFloating(ws, id)
      ? { ...ws, floating: ws.floating.map((f) => (f.id === id ? { ...f, rect: fitted } : f)) }
      : ws
  );
}

/**
 * Sets the ratio of a split on the active workspace, clamped so both sides keep their nested
 * minimum size in this viewport. A split whose minimums leave no room to move keeps its ratio.
 */
export function resizeSplit<P>(
  desktop: Desktop<P>,
  path: NodePath,
  ratio: number,
  metrics: LayoutMetrics
): Desktop<P> {
  const workspace = activeWorkspace(desktop);
  const gutter = layoutTree(workspace.root, metrics).gutters.find((g) => g.path === path);

  if (
    workspace.root === null ||
    gutter === undefined ||
    gutter.minRatio >= gutter.maxRatio ||
    !Number.isFinite(ratio)
  ) {
    return desktop;
  }

  const root = setRatioAt(workspace.root, path, clamp(ratio, gutter.minRatio, gutter.maxRatio));
  return updateWorkspace(desktop, desktop.active, (ws) =>
    root === ws.root ? ws : { ...ws, root }
  );
}

/** Changes a split's ratio by a step, for keyboard resizing, within the minimum sizes. */
export function nudgeSplit<P>(
  desktop: Desktop<P>,
  path: NodePath,
  delta: number,
  metrics: LayoutMetrics
): Desktop<P> {
  const { gutters } = layoutTree(activeWorkspace(desktop).root, metrics);
  const gutter = gutters.find((g) => g.path === path);
  return gutter === undefined ? desktop : resizeSplit(desktop, path, gutter.ratio + delta, metrics);
}

/** Resets a split to 50/50, or as close as the minimum sizes allow. */
export function resetSplit<P>(
  desktop: Desktop<P>,
  path: NodePath,
  metrics: LayoutMetrics
): Desktop<P> {
  return resizeSplit(desktop, path, 0.5, metrics);
}
