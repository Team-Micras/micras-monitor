/**
 * Operations on the whole desktop. Each takes a desktop and returns the next one. An operation
 * that does not apply, or that asks for the state already in place, returns the desktop it was
 * given, so callers can skip work by comparing identities. Moves and drops are the exception:
 * one that puts a window back where it already was rebuilds the tree and returns an equal but
 * new desktop.
 *
 * @module
 */

import { findNeighbor, readingOrder } from './focus';
import { clamp, openRatio } from './geometry';
import { fitFloating, layoutTree, layoutWorkspace } from './layout';
import { LayoutError } from './layout-error';
import { nodeAt, pathOf, setRatioAt, swapLeaves } from './tree';
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
import { firstRepeated, validateDesktop } from './validate';
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
  const repeated = firstRepeated(list.map((window) => window.id));

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

/** The visible window physically on one side of the focused one, as `findNeighbor` ranks it. */
export function neighborOf(
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
  return findNeighbor(windows, focused, direction, workspace.focus);
}

/** Moves the focus to the window physically on one side of the focused one. */
export function focusDirection<P>(
  desktop: Desktop<P>,
  direction: Direction,
  metrics: LayoutMetrics
): Desktop<P> {
  const target = neighborOf(desktop, direction, metrics);
  return target === null ? desktop : focusWindow(desktop, target);
}

/** Moves the focus to the next visible window of the active workspace in reading order. */
export function focusNext<P>(desktop: Desktop<P>, metrics: LayoutMetrics): Desktop<P> {
  return focusInReadingOrder(desktop, 1, metrics);
}

/** Moves the focus to the previous visible window of the active workspace in reading order. */
export function focusPrevious<P>(desktop: Desktop<P>, metrics: LayoutMetrics): Desktop<P> {
  return focusInReadingOrder(desktop, -1, metrics);
}

function focusInReadingOrder<P>(
  desktop: Desktop<P>,
  offset: number,
  metrics: LayoutMetrics
): Desktop<P> {
  const workspace = activeWorkspace(desktop);
  const order = readingOrder(layoutWorkspace(workspace, metrics));

  if (order.length === 0) {
    return desktop;
  }

  const index = order.indexOf(focusedWindow(workspace) ?? '');
  const next = index === -1 ? order[0] : order[(index + offset + order.length) % order.length];
  return focusWindow(desktop, next);
}

/** Exchanges the tiles of two windows tiled in the same workspace; the focus does not move. */
export function swapWindows<P>(desktop: Desktop<P>, a: WindowId, b: WindowId): Desktop<P> {
  const index = tiledWorkspaceOf(desktop, a);

  if (a === b || index === -1 || index !== tiledWorkspaceOf(desktop, b)) {
    return desktop;
  }

  return updateWorkspace(desktop, index, (ws) => {
    const root = ws.root === null ? null : swapLeaves(ws.root, a, b);
    return root === ws.root ? ws : { ...ws, root };
  });
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
  const target = findNeighbor(tiled, focused, direction, workspace.focus);
  return target === null ? desktop : swapWindows(desktop, focused, target);
}

/**
 * Moves a window, tiled or floating, beside a tiled window, splitting that tile, and focuses it.
 * The target's workspace is shown. The window keeps its id, so views keyed by it stay mounted. A
 * move back to the place the window already had returns an equal but new desktop.
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
 * Unlike Hyprland, an index past the last workspace changes nothing instead of creating one:
 * workspaces here are named tabs the user creates, and a gap such as index 7 of 4 would need
 * placeholder names the engine has no business inventing. Call `addWorkspace` first.
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

/**
 * Maximizes a tiled window, focusing it, or restores the tiling of its workspace when a window
 * of that workspace is maximized.
 *
 * @param id The window; the focused window of the active workspace by default.
 */
export function toggleMaximize<P>(
  desktop: Desktop<P>,
  id: WindowId | null = focusedWindow(activeWorkspace(desktop))
): Desktop<P> {
  const index = id === null ? desktop.active : workspaceOf(desktop, id);

  if (index === -1) {
    return desktop;
  }

  return updateWorkspace(desktop, index, (ws) => {
    if (ws.maximized !== null) {
      return { ...ws, maximized: null };
    }

    return id !== null && isTiled(ws, id) ? { ...withFocus(ws, id), maximized: id } : ws;
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
  return updateWorkspace(desktop, index, (ws) => {
    const entry = ws.floating.find((f) => f.id === id);

    if (entry === undefined || sameRect(entry.rect, fitted)) {
      return ws;
    }

    return { ...ws, floating: ws.floating.map((f) => (f === entry ? { ...f, rect: fitted } : f)) };
  });
}

function sameRect(a: Rect, b: Rect): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

/**
 * Sets the ratio of a split on the active workspace, clamped so both sides keep their nested
 * minimum size in this viewport, and strictly inside (0, 1). A split whose minimums leave no room
 * to move keeps its ratio.
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

  const clamped = openRatio(clamp(ratio, gutter.minRatio, gutter.maxRatio));
  const root = setRatioAt(workspace.root, path, clamped);
  return updateWorkspace(desktop, desktop.active, (ws) =>
    root === ws.root ? ws : { ...ws, root }
  );
}

/**
 * Changes a split's ratio by a step, for keyboard resizing, within the minimum sizes. The step
 * starts from the stored ratio as the viewport clamps it, so repeated steps do not drift.
 */
export function nudgeSplit<P>(
  desktop: Desktop<P>,
  path: NodePath,
  delta: number,
  metrics: LayoutMetrics
): Desktop<P> {
  const { root } = activeWorkspace(desktop);
  const node = nodeAt(root, path);
  const gutter = layoutTree(root, metrics).gutters.find((g) => g.path === path);

  if (delta === 0 || node === null || node.type !== 'split' || gutter === undefined) {
    return desktop;
  }

  const from = clamp(node.ratio, gutter.minRatio, gutter.maxRatio);
  return resizeSplit(desktop, path, from + delta, metrics);
}

/**
 * Resizes the focused tiled window from the keyboard: the nearest split above it that divides
 * the axis of `direction` moves its gutter toward `direction` by `step`, a share of that split.
 * Right and down grow the split's first side; left and up grow its second side.
 */
export function resizeFocused<P>(
  desktop: Desktop<P>,
  direction: Direction,
  step: number,
  metrics: LayoutMetrics
): Desktop<P> {
  const { root, focus } = activeWorkspace(desktop);
  const path = focus[0] === undefined ? null : pathOf(root, focus[0]);

  if (path === null) {
    return desktop;
  }

  const orientation = direction === 'left' || direction === 'right' ? 'row' : 'column';
  const ancestors = Array.from({ length: path.length }, (_, i) =>
    path.slice(0, path.length - 1 - i)
  );
  const split = ancestors.find((ancestor) => {
    const node = nodeAt(root, ancestor);
    return node !== null && node.type === 'split' && node.orientation === orientation;
  });
  const sign = direction === 'right' || direction === 'down' ? 1 : -1;
  return split === undefined ? desktop : nudgeSplit(desktop, split, sign * step, metrics);
}

/** Resets a split to 50/50, or as close as the minimum sizes allow. */
export function resetSplit<P>(
  desktop: Desktop<P>,
  path: NodePath,
  metrics: LayoutMetrics
): Desktop<P> {
  return resizeSplit(desktop, path, 0.5, metrics);
}
