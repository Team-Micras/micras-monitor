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
 * @param workspaces How many workspaces there are.
 */
export function tilingCommandFor<P>(action: KeyAction, workspaces: number): Command<P> | null {
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
