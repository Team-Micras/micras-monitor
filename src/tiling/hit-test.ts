/**
 * Drag and drop: where a window dragged over the active workspace would land, and applying it.
 *
 * @module
 */

import { activeWorkspace, focusWindow, moveToWorkspace, moveWindow, swapWindows } from './desktop';
import { unreachable } from './errors';
import { containsPoint } from './geometry';
import { layoutTree, layoutWorkspace } from './layout';
import type { Desktop, EdgePlacement, LayoutMetrics, Point, Rect, Side, WindowId } from './types';
import { detach, isTiled, tileBeside } from './workspace';

/**
 * Where a drop lands. `center` swaps with a window, `edge` splits its tile and puts the dropped
 * window on that side, `workspace` moves the window to another workspace. The engine reports the
 * first two; the caller builds `workspace` when the pointer is over a workspace tab. `preview` is
 * the rect the dropped window will take, gaps and minimum sizes included.
 */
export type DropTarget =
  | { readonly kind: 'center'; readonly id: WindowId; readonly preview: Rect }
  | {
      readonly kind: 'edge';
      readonly id: WindowId;
      readonly side: Side;
      readonly preview: Rect;
    }
  | { readonly kind: 'workspace'; readonly index: number };

const CENTER_ZONE = 0.44;
const PREVIEW_ID: WindowId = '';

/**
 * Hit-tests a point over the active workspace. The central box of a visible tile (44 % of its
 * width and height) means center; anywhere else in the tile, the nearest edge. Floating windows
 * cover what is under them, and the dragged window's own tile and the gaps are not targets. The
 * center only swaps two tiled windows, so it is no target for a floating window or one from
 * another workspace; floating windows move with `placeFloating`.
 *
 * @param desktop The desktop being dragged over.
 * @param dragged The window being dragged, or null for something new, such as a variable dragged
 *   from the drawer, whose edge preview is the tile a new window would take.
 * @param point The pointer, in viewport pixels.
 * @param metrics The viewport.
 * @returns The target under the pointer, or null.
 */
export function hitTest(
  desktop: Desktop,
  dragged: WindowId | null,
  point: Point,
  metrics: LayoutMetrics
): DropTarget | null {
  const workspace = activeWorkspace(desktop);
  const visible = layoutWorkspace(workspace, metrics).windows.filter(
    (window) => window.visible && window.id !== dragged
  );

  if (visible.some((window) => window.floating && containsPoint(window.rect, point))) {
    return null;
  }

  const tile = visible.find((window) => !window.floating && containsPoint(window.rect, point));

  if (tile === undefined) {
    return null;
  }

  const zone = zoneAt(tile.rect, point);

  if (zone === 'center') {
    const swappable = dragged === null || isTiled(workspace, dragged);
    return swappable ? { kind: 'center', id: tile.id, preview: tile.rect } : null;
  }

  const at = { target: tile.id, side: zone };
  const preview = edgePreview(desktop, dragged, at, metrics) ?? tile.rect;
  return { kind: 'edge', id: tile.id, side: zone, preview };
}

function zoneAt(rect: Rect, point: Point): Side | 'center' {
  const u = rect.width > 0 ? (point.x - rect.x) / rect.width : 0.5;
  const v = rect.height > 0 ? (point.y - rect.y) / rect.height : 0.5;
  const half = CENTER_ZONE / 2;

  if (Math.abs(u - 0.5) < half && Math.abs(v - 0.5) < half) {
    return 'center';
  }

  const distances: readonly (readonly [Side, number])[] = [
    ['left', u],
    ['right', 1 - u],
    ['top', v],
    ['bottom', 1 - v],
  ];
  return distances.reduce((nearest, entry) => (entry[1] < nearest[1] ? entry : nearest))[0];
}

function edgePreview(
  desktop: Desktop,
  dragged: WindowId | null,
  at: EdgePlacement,
  metrics: LayoutMetrics
): Rect | undefined {
  const workspace = activeWorkspace(desktop);
  const id = dragged ?? PREVIEW_ID;
  const without = dragged === null ? workspace : detach(workspace, dragged).workspace;
  const simulated = tileBeside(without, id, at);
  return layoutTree(simulated.root, metrics).tiles.get(id);
}

/**
 * Applies a drop: `center` swaps the two tiled windows, `edge` moves the dragged window beside
 * the target, `workspace` moves it to that workspace without showing it. The dragged window ends
 * up focused in its new place and keeps its id. A drop that changes nothing returns the desktop
 * unchanged, except an edge drop back onto the place the window had, which returns an equal but
 * new desktop.
 */
export function applyDrop<P>(
  desktop: Desktop<P>,
  dragged: WindowId,
  target: DropTarget,
  metrics: LayoutMetrics
): Desktop<P> {
  switch (target.kind) {
    case 'center':
      return swapAndFocus(desktop, dragged, target.id);
    case 'edge':
      return moveWindow(desktop, dragged, { target: target.id, side: target.side });
    case 'workspace':
      return moveToWorkspace(desktop, dragged, target.index, metrics, false);
    default:
      return unreachable(target);
  }
}

function swapAndFocus<P>(desktop: Desktop<P>, dragged: WindowId, target: WindowId): Desktop<P> {
  const swapped = swapWindows(desktop, dragged, target);
  return swapped === desktop ? desktop : focusWindow(swapped, dragged);
}
