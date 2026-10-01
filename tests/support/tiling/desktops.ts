/**
 * Desktops and viewports shared by the tiling tests.
 *
 * @module
 */

import { activeWorkspace, createDesktop } from '@/tiling/desktop';
import { layoutTree, layoutWorkspace, type PlacedWindow } from '@/tiling/layout';
import { leaf, split } from '@/tiling/tree';
import type {
  Desktop,
  LayoutMetrics,
  Rect,
  TilingWindow,
  WindowId,
  Workspace,
} from '@/tiling/types';
import { createWorkspace, windowIds } from '@/tiling/workspace';

/** The spike's viewport: 14 px gaps inside and to the edges, 240 × 150 minimum windows. */
export const METRICS: LayoutMetrics = {
  width: 1614,
  height: 828,
  gap: 14,
  outerGap: 14,
  minWidth: 240,
  minHeight: 150,
};

/** A window whose kind names it and whose payload is its id. */
export function windowOf(id: WindowId): TilingWindow<string> {
  return { id, kind: 'test', payload: id };
}

/** A desktop with a test window for every window the workspaces hold. */
export function desktopOf(workspaces: readonly Workspace[], active = 0): Desktop<string> {
  return createDesktop(workspaces, workspaces.flatMap(windowIds).map(windowOf), active);
}

/**
 * The mockup's Overview, `track` focused, beside an empty Tracking workspace:
 *
 * ```
 * track | maze
 * ------+--------
 * robot | profile
 * ```
 */
export function overview(): Desktop<string> {
  const root = split(
    'row',
    0.6,
    split('column', 0.6, leaf('track'), leaf('robot')),
    split('column', 0.6, leaf('maze'), leaf('profile'))
  );
  return desktopOf([createWorkspace('Overview', root, 'track'), createWorkspace('Tracking')]);
}

/** The tile of a window on the active workspace, ignoring maximize. */
export function tileOf(desktop: Desktop, id: WindowId, metrics = METRICS): Rect {
  const rect = layoutTree(activeWorkspace(desktop).root, metrics).tiles.get(id);

  if (rect === undefined) {
    throw new Error(`"${id}" is not tiled on the active workspace`);
  }

  return rect;
}

/** The placed windows of the active workspace, keyed by id. */
export function placedOf(desktop: Desktop, metrics = METRICS): ReadonlyMap<WindowId, PlacedWindow> {
  const { windows } = layoutWorkspace(activeWorkspace(desktop), metrics);
  return new Map(windows.map((window) => [window.id, window]));
}
