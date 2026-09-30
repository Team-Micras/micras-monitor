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
  /** Its hit area: the window's corner and the quarter of the gaps' crossing next to it. */
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

function handleRect(tile: Rect, corner: Corner, metrics: LayoutMetrics, inset: number): Rect {
  const reach = metrics.gap / 2;
  const size = inset + reach;
  const x = corner.endsWith('right') ? tile.x + tile.width - inset : tile.x - reach;
  const y = corner.startsWith('bottom') ? tile.y + tile.height - inset : tile.y - reach;
  return { x, y, width: size, height: size };
}

/**
 * Every corner of the active workspace's tiled windows where two gaps meet. Where four windows
 * meet, each owns the quarter of the crossing next to it, so the handles never overlap. A
 * maximized window leaves no handles, as it leaves no gaps.
 *
 * @param inset How far each handle reaches into its window, in pixels.
 */
export function cornerHandles(
  desktop: Desktop,
  metrics: LayoutMetrics,
  inset: number
): CornerHandle[] {
  const workspace = activeWorkspace(desktop);

  if (workspace.maximized !== null) {
    return [];
  }

  const { tiles } = layoutTree(workspace.root, metrics);
  return [...tiles].flatMap(([id, tile]) =>
    CORNERS.flatMap((corner) => {
      const splits = cornerSplits(workspace.root, id, corner);
      return splits === null
        ? []
        : [{ id, corner, ...splits, rect: handleRect(tile, corner, metrics, inset) }];
    })
  );
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
