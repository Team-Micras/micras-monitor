/**
 * Adding, renaming, reordering and removing workspaces. Each operation keeps `active` on the
 * workspace that was shown, or on the neighbor that replaces a removed one.
 *
 * @module
 */

import { clamp } from './geometry';
import { LayoutError } from './layout-error';
import type { Desktop, LayoutMetrics, TilingWindow, WindowId } from './types';
import { absorb, createWorkspace, windowIds } from './workspace';

/**
 * What happens to the windows of a removed workspace: `closeWindows` closes them;
 * `mergeIntoNeighbor` moves them into the neighbor that is shown in its place, and `mergeInto`
 * into the workspace at that index, which is then shown in its place; tiled windows go by the
 * dwindle rule and floating ones keep their rects.
 */
export type RemovePolicy = 'closeWindows' | 'mergeIntoNeighbor' | { readonly mergeInto: number };

/**
 * The workspace that takes over from a removed one: the one before it, or else the one after.
 */
export function neighborWorkspace(index: number): number {
  return index > 0 ? index - 1 : index + 1;
}

function checkName(name: string): void {
  if (name === '') {
    throw new LayoutError('name', 'must be a non-empty string');
  }
}

/**
 * Adds an empty workspace without showing it.
 *
 * @param at Where it goes, from 0 to the number of workspaces; the end by default.
 * @throws {LayoutError} When the name is empty.
 */
export function addWorkspace<P>(
  desktop: Desktop<P>,
  name: string,
  at = desktop.workspaces.length
): Desktop<P> {
  checkName(name);
  const count = desktop.workspaces.length;
  const index = Number.isInteger(at) ? clamp(at, 0, count) : count;
  return {
    ...desktop,
    workspaces: desktop.workspaces.toSpliced(index, 0, createWorkspace(name)),
    active: desktop.active >= index ? desktop.active + 1 : desktop.active,
  };
}

/**
 * Renames a workspace. An index that names no workspace, or the name it already has, changes
 * nothing.
 *
 * @throws {LayoutError} When the name is empty.
 */
export function renameWorkspace<P>(desktop: Desktop<P>, index: number, name: string): Desktop<P> {
  checkName(name);
  const workspace = desktop.workspaces[index];

  if (workspace === undefined || workspace.name === name) {
    return desktop;
  }

  return { ...desktop, workspaces: desktop.workspaces.with(index, { ...workspace, name }) };
}

/** Moves a workspace to another position. Indices that name no workspace change nothing. */
export function moveWorkspace<P>(desktop: Desktop<P>, from: number, to: number): Desktop<P> {
  const moved = desktop.workspaces[from];

  if (from === to || moved === undefined || desktop.workspaces[to] === undefined) {
    return desktop;
  }

  return {
    ...desktop,
    workspaces: desktop.workspaces.toSpliced(from, 1).toSpliced(to, 0, moved),
    active: movedIndex(desktop.active, from, to),
  };
}

function movedIndex(index: number, from: number, to: number): number {
  if (index === from) {
    return to;
  }

  const closed = index > from ? index - 1 : index;
  return closed >= to ? closed + 1 : closed;
}

/**
 * Removes a workspace, dealing with its windows by `policy`. Its neighbor (see
 * {@link neighborWorkspace}), or the workspace its windows are merged into, takes over: it is
 * shown when the removed workspace was. The last workspace cannot be removed; a desktop always
 * keeps one, and merging into the removed workspace itself or into none changes nothing.
 */
export function removeWorkspace<P>(
  desktop: Desktop<P>,
  index: number,
  policy: RemovePolicy,
  metrics: LayoutMetrics
): Desktop<P> {
  const removed = desktop.workspaces[index];
  const heir = typeof policy === 'object' ? policy.mergeInto : neighborWorkspace(index);
  const receiver = desktop.workspaces[heir];

  if (removed === undefined || receiver === undefined || heir === index) {
    return desktop;
  }

  const workspaces =
    policy === 'closeWindows'
      ? desktop.workspaces
      : desktop.workspaces.with(heir, absorb(receiver, removed, metrics));
  const windows =
    policy === 'closeWindows' ? without(desktop.windows, windowIds(removed)) : desktop.windows;
  return {
    windows,
    workspaces: workspaces.toSpliced(index, 1),
    active: activeAfterRemoving(desktop.active, index, heir),
  };
}

function activeAfterRemoving(active: number, removed: number, heir: number): number {
  if (active === removed) {
    return heir < removed ? heir : heir - 1;
  }

  return active > removed ? active - 1 : active;
}

function without<P>(
  windows: ReadonlyMap<WindowId, TilingWindow<P>>,
  ids: readonly WindowId[]
): ReadonlyMap<WindowId, TilingWindow<P>> {
  const gone = new Set(ids);
  return new Map([...windows].filter(([id]) => !gone.has(id)));
}
