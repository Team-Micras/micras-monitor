/**
 * The tiling window engine: workspaces of split trees with a floating layer, dwindle placement,
 * geometric focus, drag-and-drop hit testing and versioned snapshots.
 *
 * It is plain TypeScript over immutable data, with no DOM and no React, and depends on nothing
 * else in the monitor. The React layer renders `layoutWorkspace` and sends `execute` commands.
 *
 * @module
 */

export type * from './types';
export { LayoutError } from './layout-error';
export { containsLeaf, firstLeafId, leaf, leafIds, nodeAt, pathOf, split } from './tree';
export { centreOf, containsPoint, usableBounds } from './geometry';
export {
  fitFloating,
  layoutTree,
  layoutWorkspace,
  minimumSize,
  ratioAtPoint,
  type Gutter,
  type MinimumSize,
  type PlacedWindow,
  type TreeLayout,
  type WorkspaceLayout,
} from './layout';
export { findNeighbour, readingOrder } from './focus';
export {
  createWorkspace,
  dwindlePlacement,
  focusedWindow,
  isFloating,
  isTiled,
  windowIds,
} from './workspace';
export {
  activeWorkspace,
  closeWindow,
  createDesktop,
  focusDirection,
  focusWindow,
  moveToWorkspace,
  moveWindow,
  neighbourOf,
  nudgeSplit,
  openWindow,
  placeFloating,
  resetSplit,
  resizeSplit,
  swapDirection,
  swapWindows,
  switchWorkspace,
  toggleFloating,
  toggleMaximize,
  workspaceOf,
} from './desktop';
export { applyDrop, hitTest, type DropTarget } from './hit-test';
export { execute, type Command } from './commands';
export {
  LAYOUT_MIGRATIONS,
  LAYOUT_VERSION,
  restoreDesktop,
  serializeDesktop,
  type DesktopSnapshot,
  type Migration,
  type RestoreOptions,
} from './serialize';
export { validateDesktop } from './validate';
