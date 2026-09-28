/**
 * The rules every desktop obeys, checked on restore, on creation and by the property tests.
 *
 * @module
 */

import { LayoutError } from './layout-error';
import { leafIds } from './tree';
import type { Desktop, FloatingWindow, Rect, TileNode, WindowId, Workspace } from './types';
import { windowIds } from './workspace';

type Placed = Map<WindowId, string>;

/**
 * Checks that a desktop is well formed: at least one workspace and a valid active index; every
 * window of `windows` placed exactly once, in one tree or floating layer; nothing placed that
 * `windows` does not know; ratios strictly between 0 and 1; finite rects; a focus history of
 * distinct windows of its own workspace, not empty while the workspace has windows; and a
 * maximized window tiled in its own workspace.
 *
 * @throws {LayoutError} Naming the first field that breaks a rule.
 */
export function validateDesktop(desktop: Desktop): void {
  if (desktop.workspaces.length === 0) {
    throw new LayoutError('workspaces', 'must hold at least one workspace');
  }

  const { active } = desktop;

  if (!Number.isInteger(active) || active < 0 || active >= desktop.workspaces.length) {
    throw new LayoutError('active', `is ${String(active)}, which is not a workspace index`);
  }

  const known = [...desktop.windows];
  known.forEach(([key, window], index) => {
    if (key !== window.id) {
      throw new LayoutError(`windows[${index}].id`, `is "${window.id}" but is filed as "${key}"`);
    }

    checkId(window.id, `windows[${index}].id`);

    if (typeof window.kind !== 'string' || window.kind === '') {
      throw new LayoutError(`windows[${index}].kind`, 'must be a non-empty string');
    }
  });

  const placed: Placed = new Map();
  desktop.workspaces.forEach((workspace, index) => {
    checkWorkspace(workspace, `workspaces[${index}]`, desktop.windows, placed);
  });

  const unplaced = known.findIndex(([id]) => !placed.has(id));

  if (unplaced !== -1) {
    throw new LayoutError(`windows[${unplaced}]`, `"${known[unplaced][0]}" is in no workspace`);
  }
}

function checkWorkspace(
  workspace: Workspace,
  where: string,
  windows: Desktop['windows'],
  placed: Placed
): void {
  if (typeof workspace.name !== 'string' || workspace.name === '') {
    throw new LayoutError(`${where}.name`, 'must be a non-empty string');
  }

  if (workspace.root !== null) {
    checkNode(workspace.root, `${where}.root`, windows, placed);
  }

  workspace.floating.forEach((entry, index) => {
    checkFloating(entry, `${where}.floating[${index}]`, windows, placed);
  });

  checkFocus(workspace, where);
  checkMaximized(workspace, where);
}

function checkNode(
  node: TileNode,
  where: string,
  windows: Desktop['windows'],
  placed: Placed
): void {
  if (node.type === 'leaf') {
    checkPlacement(node.id, `${where}.id`, windows, placed);
    return;
  }

  checkRatio(node.ratio, `${where}.ratio`);
  checkNode(node.first, `${where}.first`, windows, placed);
  checkNode(node.second, `${where}.second`, windows, placed);
}

function checkFloating(
  entry: FloatingWindow,
  where: string,
  windows: Desktop['windows'],
  placed: Placed
): void {
  checkPlacement(entry.id, `${where}.id`, windows, placed);
  checkRect(entry.rect, `${where}.rect`);

  if (entry.dock === null) {
    return;
  }

  if (entry.dock.sibling.length === 0) {
    throw new LayoutError(`${where}.dock.sibling`, 'must name at least one window');
  }

  entry.dock.sibling.forEach((id, index) => {
    checkId(id, `${where}.dock.sibling[${index}]`);
  });
  checkRatio(entry.dock.ratio, `${where}.dock.ratio`);
}

function checkFocus(workspace: Workspace, where: string): void {
  const members = new Set(windowIds(workspace));
  const seen = new Set<WindowId>();

  workspace.focus.forEach((id, index) => {
    if (!members.has(id)) {
      throw new LayoutError(
        `${where}.focus[${index}]`,
        `"${id}" is not a window of this workspace`
      );
    }

    if (seen.has(id)) {
      throw new LayoutError(`${where}.focus[${index}]`, `"${id}" is listed twice`);
    }

    seen.add(id);
  });

  if (members.size > 0 && workspace.focus.length === 0) {
    throw new LayoutError(`${where}.focus`, 'must name the focused window');
  }
}

function checkMaximized(workspace: Workspace, where: string): void {
  const { maximized } = workspace;

  if (maximized !== null && !leafIds(workspace.root).includes(maximized)) {
    throw new LayoutError(`${where}.maximized`, `"${maximized}" is not tiled in this workspace`);
  }
}

function checkPlacement(
  id: WindowId,
  where: string,
  windows: Desktop['windows'],
  placed: Placed
): void {
  checkId(id, where);
  const earlier = placed.get(id);

  if (earlier !== undefined) {
    throw new LayoutError(where, `places "${id}" a second time; it is already at ${earlier}`);
  }

  if (!windows.has(id)) {
    throw new LayoutError(where, `places "${id}", which is not in windows`);
  }

  placed.set(id, where);
}

function checkId(id: WindowId, where: string): void {
  if (typeof id !== 'string' || id === '') {
    throw new LayoutError(where, 'must be a non-empty string');
  }
}

function checkRatio(ratio: number, where: string): void {
  if (!(ratio > 0 && ratio < 1)) {
    throw new LayoutError(where, `is ${String(ratio)}; it must lie strictly between 0 and 1`);
  }
}

function checkRect(rect: Rect, where: string): void {
  for (const key of ['x', 'y', 'width', 'height'] as const) {
    if (!Number.isFinite(rect[key])) {
      throw new LayoutError(`${where}.${key}`, 'must be a finite number');
    }
  }

  if (rect.width < 0 || rect.height < 0) {
    throw new LayoutError(where, 'must not have a negative size');
  }
}
