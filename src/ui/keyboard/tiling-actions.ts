/**
 * The keymap actions that are tiling commands.
 *
 * @module
 */

import type { Command, Direction } from '@/tiling';

import type { KeyAction } from './keymap';

const DIRECTIONS: readonly Direction[] = ['left', 'right', 'up', 'down'];

/**
 * The tiling command an action stands for, or null for actions that are not about the tiling
 * or name a workspace that does not exist. Sending a window to a workspace leaves the view where
 * it is, as dropping it on the workspace's tab does.
 *
 * Moving the workspace takes the shown one a place left or right, and nowhere past either end.
 *
 * @param workspaces How many workspaces there are.
 * @param active The index of the shown workspace.
 */
export function tilingActionFor<P>(
  action: KeyAction,
  workspaces: number,
  active = 0
): Command<P> | null {
  for (const direction of DIRECTIONS) {
    if (action === `focus.${direction}`) {
      return { type: 'focusDirection', direction };
    }

    if (action === `swap.${direction}`) {
      return { type: 'swapDirection', direction };
    }
  }

  for (let index = 0; index < Math.min(workspaces, 9); index += 1) {
    if (action === `workspace.${index + 1}`) {
      return { type: 'switchWorkspace', index };
    }

    if (action === `send-to-workspace.${index + 1}`) {
      return { type: 'moveToWorkspace', index, follow: false };
    }
  }

  switch (action) {
    case 'workspace.move-left':
      return active > 0 ? { type: 'moveWorkspace', from: active, to: active - 1 } : null;
    case 'workspace.move-right':
      return active < workspaces - 1
        ? { type: 'moveWorkspace', from: active, to: active + 1 }
        : null;
    case 'window.maximize':
      return { type: 'toggleMaximize' };
    case 'window.float':
      return { type: 'toggleFloating' };
    case 'window.close':
      return { type: 'close' };
    default:
      return null;
  }
}
