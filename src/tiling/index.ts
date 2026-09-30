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
export { centerOf, checkMetrics, containsPoint, MIN_RATIO, usableBounds } from './geometry';
export {
  fitFloating,
  layoutDesktop,
  layoutTree,
  layoutWorkspace,
  minimumSize,
  ratioAtPoint,
  type DesktopWindow,
  type Gutter,
  type MinimumSize,
  type PlacedWindow,
  type TreeLayout,
  type WorkspaceLayout,
} from './layout';
export { findNeighbor, readingOrder } from './focus';
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
  focusNext,
  focusPrevious,
  focusWindow,
  moveToWorkspace,
  moveWindow,
  neighborOf,
  nudgeSplit,
  openWindow,
  placeFloating,
  resetSplit,
  resizeFocused,
  resizeSplit,
  swapDirection,
  swapWindows,
  switchWorkspace,
  toggleFloating,
  toggleMaximize,
  workspaceOf,
} from './desktop';
export {
  addWorkspace,
  moveWorkspace,
  neighborWorkspace,
  removeWorkspace,
  renameWorkspace,
  type RemovePolicy,
} from './lifecycle';
export { applyDrop, hitTest, type DropTarget } from './hit-test';
export {
  CORNERS,
  cornerCrossing,
  cornerHandles,
  cornerSplits,
  resizeCorner,
  type Corner,
  type CornerHandle,
  type CornerSplits,
} from './corners';
export { execute, type Command } from './commands';
export {
  LAYOUT_MIGRATIONS,
  LAYOUT_VERSION,
  restoreDesktop,
  serializeDesktop,
  type DesktopSnapshot,
  type DockSnapshot,
  type FloatingSnapshot,
  type Migration,
  type NodeSnapshot,
  type RectSnapshot,
  type RestoreOptions,
  type WindowSnapshot,
  type WorkspaceSnapshot,
} from './serialize';
export { validateDesktop } from './validate';
