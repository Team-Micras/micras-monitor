/**
 * Resizing from the corners of tiled windows: where a vertical gap and a horizontal gap meet at a
 * window's corner, dragging that corner moves both splits at once, as in Hyprland.
 *
 * @module
 */

import { activeWorkspace, resizeSplit } from './desktop';
import { layoutTree, ratioAtPoint, type Gutter } from './layout';
import { nodeAt, pathOf } from './tree';
import type {
  Desktop,
  LayoutMetrics,
  NodePath,
  Orientation,
  Point,
  Rect,
  TileNode,
  WindowId,
} from './types';

/** A corner of a window. */
export type Corner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';

/** The four corners, in reading order. */
export const CORNERS: readonly Corner[] = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];

/** The two splits whose gaps border a corner of a tiled window. */
export interface CornerSplits {
  /** The side-by-side split whose gap runs along the corner's left or right edge. */
  readonly row: NodePath;
  /** The stacked split whose gap runs along the corner's top or bottom edge. */
  readonly column: NodePath;
}

/** A corner where two gaps meet, which resizes both splits when dragged. */
export interface CornerHandle extends CornerSplits {
  readonly id: WindowId;
  readonly corner: Corner;
  /** Its hit area: where the two gaps cross. */
  readonly rect: Rect;
}

function nearestSplit(
  root: TileNode | null,
  path: NodePath,
  orientation: Orientation,
  side: '0' | '1'
): NodePath | null {
  for (let length = path.length - 1; length >= 0; length -= 1) {
    const node = nodeAt(root, path.slice(0, length));

    if (node?.type === 'split' && node.orientation === orientation && path[length] === side) {
      return path.slice(0, length);
    }
  }

  return null;
}

/**
 * The splits whose gaps meet at a corner of a tiled window: on the corner's right edge, the
 * nearest side-by-side split holding the window on its first side, on its left edge the nearest
 * holding it on its second, and the same for stacked splits along the top and bottom. Null when
 * the corner lies on the edge of the tiling on either axis, or the window is not tiled.
 */
export function cornerSplits(
  root: TileNode | null,
  id: WindowId,
  corner: Corner
): CornerSplits | null {
  const path = pathOf(root, id);

  if (path === null) {
    return null;
  }

  const row = nearestSplit(root, path, 'row', corner.endsWith('right') ? '0' : '1');
  const column = nearestSplit(root, path, 'column', corner.startsWith('bottom') ? '0' : '1');
  return row === null || column === null ? null : { row, column };
}

function crossingRect(row: Gutter, column: Gutter): Rect {
  return { x: row.rect.x, width: row.rect.width, y: column.rect.y, height: column.rect.height };
}

function sameRect(a: Rect, b: Rect): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

/**
 * Every corner of the active workspace's tiled windows where two gaps meet. Each handle covers
 * only where the two gaps cross, which lies inside the outer split's gap, so it never covers a
 * window. Where two corners share a crossing, as when four windows meet in a grid, the first in
 * reading order keeps it. A maximized window leaves no handles, as it leaves no gaps.
 */
export function cornerHandles(desktop: Desktop, metrics: LayoutMetrics): CornerHandle[] {
  const workspace = activeWorkspace(desktop);

  if (workspace.maximized !== null) {
    return [];
  }

  const { tiles, gutters } = layoutTree(workspace.root, metrics);
  const gutter = (path: NodePath) => gutters.find((entry) => entry.path === path);
  const handles: CornerHandle[] = [];

  for (const id of tiles.keys()) {
    for (const corner of CORNERS) {
      const splits = cornerSplits(workspace.root, id, corner);
      const row = splits === null ? undefined : gutter(splits.row);
      const column = splits === null ? undefined : gutter(splits.column);

      if (splits !== null && row !== undefined && column !== undefined) {
        const rect = crossingRect(row, column);

        if (!handles.some((handle) => sameRect(handle.rect, rect))) {
          handles.push({ id, corner, ...splits, rect });
        }
      }
    }
  }

  return handles;
}

function gutterAt(desktop: Desktop, path: NodePath, metrics: LayoutMetrics): Gutter | undefined {
  return layoutTree(activeWorkspace(desktop).root, metrics).gutters.find((g) => g.path === path);
}

/**
 * Where the gaps of a corner's two splits cross: the middle of the vertical gap across, and of
 * the horizontal gap down. Null when either split no longer exists.
 */
export function cornerCrossing(
  desktop: Desktop,
  splits: CornerSplits,
  metrics: LayoutMetrics
): Point | null {
  const row = gutterAt(desktop, splits.row, metrics);
  const column = gutterAt(desktop, splits.column, metrics);
  return row === undefined || column === undefined
    ? null
    : { x: row.rect.x + row.rect.width / 2, y: column.rect.y + column.rect.height / 2 };
}

/**
 * Moves both splits that meet at a corner so that their gaps cross under a point, each within the
 * minimum sizes, as dragging each gap would. Splits that no longer exist are left alone.
 *
 * @param point Where the corner goes, in tiling pixels.
 */
export function resizeCorner<P>(
  desktop: Desktop<P>,
  splits: CornerSplits,
  point: Point,
  metrics: LayoutMetrics
): Desktop<P> {
  return [splits.row, splits.column].reduce((current, path) => {
    const gutter = gutterAt(current, path, metrics);
    return gutter === undefined
      ? current
      : resizeSplit(current, path, ratioAtPoint(gutter, point), metrics);
  }, desktop);
}
