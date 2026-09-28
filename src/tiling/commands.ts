/**
 * The command API: one command per keymap or pointer action, so the app maps an input to a
 * command and hands it to `execute` without knowing how the engine carries it out.
 *
 * @module
 */

import {
  activeWorkspace,
  closeWindow,
  focusDirection,
  focusNext,
  focusPrevious,
  focusWindow,
  moveToWorkspace,
  openWindow,
  resetSplit,
  resizeFocused,
  swapDirection,
  switchWorkspace,
  toggleFloating,
  toggleMaximize,
} from './desktop';
import { unreachable } from './layout-error';
import {
  addWorkspace,
  moveWorkspace,
  removeWorkspace,
  renameWorkspace,
  type RemovePolicy,
} from './lifecycle';
import type {
  Desktop,
  Direction,
  EdgePlacement,
  LayoutMetrics,
  NodePath,
  TilingWindow,
  WindowId,
} from './types';
import { focusedWindow } from './workspace';

/**
 * An action. Commands that act on a window take the focused window of the active workspace
 * unless `id` names another one.
 */
export type Command<P = unknown> =
  | { readonly type: 'focusDirection'; readonly direction: Direction }
  | { readonly type: 'focusWindow'; readonly id: WindowId }
  | { readonly type: 'focusNext' }
  | { readonly type: 'focusPrevious' }
  | { readonly type: 'swapDirection'; readonly direction: Direction }
  | { readonly type: 'resize'; readonly direction: Direction; readonly step: number }
  | { readonly type: 'resetSplit'; readonly path: NodePath }
  | { readonly type: 'switchWorkspace'; readonly index: number }
  | {
      readonly type: 'moveToWorkspace';
      readonly index: number;
      readonly id?: WindowId;
      readonly follow?: boolean;
    }
  | { readonly type: 'toggleFloating'; readonly id?: WindowId }
  | { readonly type: 'toggleMaximize' }
  | { readonly type: 'close'; readonly id?: WindowId }
  | { readonly type: 'open'; readonly window: TilingWindow<P>; readonly at?: EdgePlacement }
  | { readonly type: 'addWorkspace'; readonly name: string; readonly at?: number }
  | { readonly type: 'renameWorkspace'; readonly index: number; readonly name: string }
  | { readonly type: 'moveWorkspace'; readonly from: number; readonly to: number }
  | { readonly type: 'removeWorkspace'; readonly index: number; readonly policy: RemovePolicy };

/**
 * Carries out a command. A command with no window to act on returns the desktop unchanged.
 *
 * @throws {LayoutError} From `open`, when the window's id is empty or already open, or its kind
 *   is empty; from `addWorkspace` and `renameWorkspace`, when the name is empty.
 */
export function execute<P>(
  desktop: Desktop<P>,
  command: Command<P>,
  metrics: LayoutMetrics
): Desktop<P> {
  switch (command.type) {
    case 'focusDirection':
      return focusDirection(desktop, command.direction, metrics);
    case 'focusWindow':
      return focusWindow(desktop, command.id);
    case 'focusNext':
      return focusNext(desktop, metrics);
    case 'focusPrevious':
      return focusPrevious(desktop, metrics);
    case 'swapDirection':
      return swapDirection(desktop, command.direction, metrics);
    case 'resize':
      return resizeFocused(desktop, command.direction, command.step, metrics);
    case 'resetSplit':
      return resetSplit(desktop, command.path, metrics);
    case 'switchWorkspace':
      return switchWorkspace(desktop, command.index);
    case 'moveToWorkspace':
      return onWindow(desktop, command.id, (id) =>
        moveToWorkspace(desktop, id, command.index, metrics, command.follow ?? true)
      );
    case 'toggleFloating':
      return onWindow(desktop, command.id, (id) => toggleFloating(desktop, id, metrics));
    case 'toggleMaximize':
      return toggleMaximize(desktop);
    case 'close':
      return onWindow(desktop, command.id, (id) => closeWindow(desktop, id));
    case 'open':
      return openWindow(desktop, command.window, metrics, command.at);
    case 'addWorkspace':
      return addWorkspace(desktop, command.name, command.at);
    case 'renameWorkspace':
      return renameWorkspace(desktop, command.index, command.name);
    case 'moveWorkspace':
      return moveWorkspace(desktop, command.from, command.to);
    case 'removeWorkspace':
      return removeWorkspace(desktop, command.index, command.policy, metrics);
    default:
      return unreachable(command);
  }
}

function onWindow<P>(
  desktop: Desktop<P>,
  id: WindowId | undefined,
  run: (id: WindowId) => Desktop<P>
): Desktop<P> {
  const target = id ?? focusedWindow(activeWorkspace(desktop));
  return target === null ? desktop : run(target);
}
