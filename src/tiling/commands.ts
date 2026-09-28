/**
 * The command API: one command per keymap action, so the app maps a key to a command and hands
 * it to `execute` without knowing how the engine carries it out.
 *
 * @module
 */

import {
  activeWorkspace,
  closeWindow,
  focusDirection,
  moveToWorkspace,
  openWindow,
  swapDirection,
  switchWorkspace,
  toggleFloating,
  toggleMaximize,
} from './desktop';
import type {
  Desktop,
  Direction,
  EdgePlacement,
  LayoutMetrics,
  TilingWindow,
  WindowId,
} from './types';
import { focusedWindow } from './workspace';

/**
 * A keymap action. Commands that act on a window take the focused window of the active
 * workspace unless `id` names another one.
 */
export type Command<P = unknown> =
  | { readonly type: 'focusDirection'; readonly direction: Direction }
  | { readonly type: 'swapDirection'; readonly direction: Direction }
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
  | { readonly type: 'open'; readonly window: TilingWindow<P>; readonly at?: EdgePlacement };

/**
 * Carries out a command. A command with no window to act on returns the desktop unchanged.
 *
 * @throws {LayoutError} From `open`, when the window's id is empty or already open, or its kind
 *   is empty.
 */
export function execute<P>(
  desktop: Desktop<P>,
  command: Command<P>,
  metrics: LayoutMetrics
): Desktop<P> {
  switch (command.type) {
    case 'focusDirection':
      return focusDirection(desktop, command.direction, metrics);
    case 'swapDirection':
      return swapDirection(desktop, command.direction, metrics);
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
    default:
      return openWindow(desktop, command.window, metrics, command.at);
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
