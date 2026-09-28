/**
 * Operations on a single workspace: focus history, taking a window out, placing one by the
 * dwindle rule or beside a tile, and moving windows between the tiling and the floating layer.
 *
 * @module
 */

import {
  areaOf,
  centreOf,
  clamp,
  containsPoint,
  extentAlong,
  keepInside,
  minimumAlong,
  usableBounds,
} from './geometry';
import { fitFloating, layoutTree } from './layout';
import {
  containsLeaf,
  findSubtree,
  firstLeafId,
  insertBeside,
  leaf,
  leafIds,
  nodeAt,
  orientationOf,
  pathOf,
  removeLeaf,
  sideOf,
  type Removal,
} from './tree';
import type {
  DockMemory,
  EdgePlacement,
  FloatingWindow,
  LayoutMetrics,
  NodePath,
  Rect,
  Side,
  TileNode,
  WindowId,
  Workspace,
} from './types';

const FLOATING_TILE_SHARE = 0.75;
const FLOATING_BOUNDS_SHARE = 0.6;

interface Slot {
  readonly path: NodePath;
  readonly side: Side;
  readonly ratio: number;
}

/** A workspace after a window was taken out of it, and the floating entry it had, if any. */
export interface Detached {
  readonly workspace: Workspace;
  readonly floating: FloatingWindow | null;
}

/**
 * Creates a workspace.
 *
 * @param name What the workspace tab shows.
 * @param root A prebuilt split tree, or null for an empty workspace.
 * @param focused The focused window; defaults to the tree's first window.
 */
export function createWorkspace(
  name: string,
  root: TileNode | null = null,
  focused: WindowId | null = firstLeafId(root)
): Workspace {
  return { name, root, floating: [], focus: focused === null ? [] : [focused], maximized: null };
}

/** The focused window of a workspace, or null. */
export function focusedWindow(workspace: Workspace): WindowId | null {
  return workspace.focus[0] ?? null;
}

/** Every window of a workspace: tiled ones in tree order, then floating ones bottom to top. */
export function windowIds(workspace: Workspace): WindowId[] {
  return [...leafIds(workspace.root), ...workspace.floating.map((entry) => entry.id)];
}

/** Tells whether a window is in a workspace's floating layer. */
export function isFloating(workspace: Workspace, id: WindowId): boolean {
  return workspace.floating.some((entry) => entry.id === id);
}

/** Tells whether a window is tiled in a workspace. */
export function isTiled(workspace: Workspace, id: WindowId): boolean {
  return containsLeaf(workspace.root, id);
}

/** Tells whether a window belongs to a workspace, tiled or floating. */
export function holds(workspace: Workspace, id: WindowId): boolean {
  return isTiled(workspace, id) || isFloating(workspace, id);
}

/**
 * Focuses a window of the workspace: it moves to the front of the history, a floating window is
 * raised to the top, and focusing a tiled window hidden behind a maximized one restores the
 * tiling.
 */
export function withFocus(workspace: Workspace, id: WindowId): Workspace {
  const focus =
    workspace.focus[0] === id ? workspace.focus : [id, ...workspace.focus.filter((f) => f !== id)];
  const floating = raise(workspace.floating, id);

  if (focus === workspace.focus && floating === workspace.floating) {
    return settleMaximized(workspace);
  }

  return settleMaximized({ ...workspace, focus, floating });
}

function raise(floating: readonly FloatingWindow[], id: WindowId): readonly FloatingWindow[] {
  const entry = floating.find((f) => f.id === id);

  if (entry === undefined || floating.at(-1) === entry) {
    return floating;
  }

  return [...floating.filter((f) => f !== entry), entry];
}

function settleMaximized(workspace: Workspace): Workspace {
  const focused = focusedWindow(workspace);
  const hidden =
    workspace.maximized !== null &&
    focused !== null &&
    focused !== workspace.maximized &&
    isTiled(workspace, focused);
  return hidden ? { ...workspace, maximized: null } : workspace;
}

/**
 * Takes a window out of a workspace. A tiled window's sibling is promoted into its space. When
 * the window had the focus, the previous one in the history takes it; with no history left, the
 * promoted sibling does, or else any remaining window.
 */
export function detach(workspace: Workspace, id: WindowId): Detached {
  const entry = workspace.floating.find((f) => f.id === id) ?? null;
  const removal =
    entry === null ? removeTiled(workspace.root, id) : { root: workspace.root, promoted: null };

  if (removal === null) {
    return { workspace, floating: null };
  }

  const { root, promoted } = removal;
  const floating = workspace.floating.filter((f) => f.id !== id);
  const fallback =
    firstLeafId(promoted === null ? null : nodeAt(root, promoted)) ??
    firstLeafId(root) ??
    floating.at(-1)?.id ??
    null;
  const detached: Workspace = {
    ...workspace,
    root,
    floating,
    focus: refocus(workspace.focus, id, fallback),
    maximized: workspace.maximized === id ? null : workspace.maximized,
  };
  return { workspace: settleMaximized(detached), floating: entry };
}

function removeTiled(root: TileNode | null, id: WindowId): Removal | null {
  return root !== null && containsLeaf(root, id) ? removeLeaf(root, id) : null;
}

function refocus(
  focus: readonly WindowId[],
  removed: WindowId,
  fallback: WindowId | null
): readonly WindowId[] {
  const remaining = focus.filter((f) => f !== removed);
  return remaining.length > 0 || fallback === null ? remaining : [fallback];
}

/**
 * Where the dwindle rule puts the next window: the anchor's tile split along its longer side. If
 * the halves would break the minimum size, the largest tile whose longer side fits is used
 * instead; failing that, the first tile (anchor first, then by area) whose shorter side fits;
 * failing that, the anchor's longer side regardless, and the layout's rule for minimums that do
 * not fit takes over.
 *
 * @param workspace The workspace to place a window in.
 * @param metrics The viewport the decision is made for.
 * @param anchor The preferred tile; when it is not tiled, the most recently focused tiled window
 *   is used, then the first one.
 * @returns The tile to split and the side the new window takes, or null for an empty workspace.
 */
export function dwindlePlacement(
  workspace: Workspace,
  metrics: LayoutMetrics,
  anchor: WindowId | null = focusedWindow(workspace)
): EdgePlacement | null {
  const tiles = [...layoutTree(workspace.root, metrics).tiles];

  if (tiles.length === 0) {
    return null;
  }

  const preferred = preferredTile(workspace, new Set(tiles.map(([id]) => id)), anchor);
  const candidates = tiles.toSorted(
    ([a, rectA], [b, rectB]) =>
      Number(b === preferred) - Number(a === preferred) || areaOf(rectB) - areaOf(rectA)
  );
  const first = candidates[0];
  const longer = candidates.find(([, rect]) => fits(rect, longerSide(rect), metrics));

  if (longer !== undefined) {
    return { target: longer[0], side: longerSide(longer[1]) };
  }

  const shorter = candidates.find(([, rect]) => fits(rect, shorterSide(rect), metrics));

  if (shorter !== undefined) {
    return { target: shorter[0], side: shorterSide(shorter[1]) };
  }

  return { target: first[0], side: longerSide(first[1]) };
}

function preferredTile(
  workspace: Workspace,
  tiled: ReadonlySet<WindowId>,
  anchor: WindowId | null
): WindowId {
  if (anchor !== null && tiled.has(anchor)) {
    return anchor;
  }

  return workspace.focus.find((id) => tiled.has(id)) ?? [...tiled][0];
}

function fits(rect: Rect, side: Side, metrics: LayoutMetrics): boolean {
  const orientation = orientationOf(side);
  const half = Math.floor((extentAlong(rect, orientation) - metrics.gap) / 2);
  return half >= minimumAlong(metrics, orientation);
}

function longerSide(rect: Rect): Side {
  return rect.width >= rect.height ? 'right' : 'bottom';
}

function shorterSide(rect: Rect): Side {
  return rect.width >= rect.height ? 'bottom' : 'right';
}

/** Tiles a window by the dwindle rule and focuses it. */
export function tileByDwindle(
  workspace: Workspace,
  id: WindowId,
  metrics: LayoutMetrics,
  anchor: WindowId | null = focusedWindow(workspace)
): Workspace {
  const placement = dwindlePlacement(workspace, metrics, anchor);
  return placement === null ? tileIn(workspace, id, null) : tileBeside(workspace, id, placement);
}

/**
 * Tiles a window beside a tile and focuses it. Returns the workspace unchanged when the target is
 * not tiled in it.
 */
export function tileBeside(workspace: Workspace, id: WindowId, at: EdgePlacement): Workspace {
  const path = pathOf(workspace.root, at.target);
  return path === null ? workspace : tileIn(workspace, id, { path, side: at.side, ratio: 0.5 });
}

function tileIn(workspace: Workspace, id: WindowId, slot: Slot | null): Workspace {
  const root =
    workspace.root === null || slot === null
      ? (workspace.root ?? leaf(id))
      : insertBeside(workspace.root, slot.path, id, slot.side, slot.ratio);
  return withFocus({ ...workspace, root, maximized: null }, id);
}

/** Adds a window to the floating layer, on top, and focuses it. */
export function addFloating(workspace: Workspace, entry: FloatingWindow): Workspace {
  return withFocus({ ...workspace, floating: [...workspace.floating, entry] }, entry.id);
}

/**
 * Lifts a tiled window into the floating layer, centred on its tile at three quarters of its
 * size (capped at 60 % of the usable bounds), and remembers where it was tiled.
 */
export function lift(workspace: Workspace, id: WindowId, metrics: LayoutMetrics): Workspace {
  const tile = layoutTree(workspace.root, metrics).tiles.get(id);

  if (tile === undefined) {
    return workspace;
  }

  const memory = dockMemoryOf(workspace.root, id);
  const { workspace: detached } = detach(workspace, id);
  return addFloating(detached, { id, rect: floatingRectFor(tile, metrics), dock: memory });
}

function dockMemoryOf(root: TileNode | null, id: WindowId): DockMemory | null {
  const path = pathOf(root, id);

  if (path === null || path === '') {
    return null;
  }

  const parent = nodeAt(root, path.slice(0, -1));

  if (parent === null || parent.type !== 'split') {
    return null;
  }

  const first = path.endsWith('0');
  return {
    sibling: leafIds(first ? parent.second : parent.first),
    side: sideOf(parent.orientation, first),
    ratio: parent.ratio,
  };
}

function floatingRectFor(tile: Rect, metrics: LayoutMetrics): Rect {
  const bounds = usableBounds(metrics);
  const width = Math.round(
    clamp(tile.width * FLOATING_TILE_SHARE, metrics.minWidth, bounds.width * FLOATING_BOUNDS_SHARE)
  );
  const height = Math.round(
    clamp(
      tile.height * FLOATING_TILE_SHARE,
      metrics.minHeight,
      bounds.height * FLOATING_BOUNDS_SHARE
    )
  );
  const x = Math.round(tile.x + (tile.width - width) / 2);
  const y = Math.round(tile.y + (tile.height - height) / 2);
  return fitFloating(keepInside({ x, y, width, height }, bounds), metrics);
}

/**
 * Docks a floating window back into the tiling: beside the subtree it was lifted from when that
 * subtree still exists with exactly the same windows, with the old ratio; otherwise by the dwindle
 * rule, anchored on the tile under the window's centre.
 */
export function dock(workspace: Workspace, id: WindowId, metrics: LayoutMetrics): Workspace {
  const { workspace: detached, floating } = detach(workspace, id);

  if (floating === null) {
    return workspace;
  }

  const path = floating.dock === null ? null : findSubtree(detached.root, floating.dock.sibling);

  if (path !== null && floating.dock !== null) {
    return tileIn(detached, id, { path, side: floating.dock.side, ratio: floating.dock.ratio });
  }

  return tileByDwindle(detached, id, metrics, tileUnder(detached, floating.rect, metrics));
}

function tileUnder(workspace: Workspace, rect: Rect, metrics: LayoutMetrics): WindowId | null {
  const centre = centreOf(fitFloating(rect, metrics));
  const tiles = [...layoutTree(workspace.root, metrics).tiles];
  return tiles.find(([, tile]) => containsPoint(tile, centre))?.[0] ?? null;
}
