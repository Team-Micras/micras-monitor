/**
 * The UI state of the shell: the desktop of windows, the viewport it is laid out in, the theme,
 * which overlay is open, drags in progress and the keymap. Robot data stays in the monitor. The
 * state is one zustand store built from slices: desktop, layouts, ui, drag and commands.
 *
 * @module
 */

import { createContext, use } from 'react';
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';

import type { Desktop, WindowId } from '@/tiling';

import type { WindowPayload } from '../../windows/types';
import { commandsSlice } from './commands';
import { desktopSlice } from './desktop';
import { dragSlice } from './drag';
import { layoutsSlice } from './layouts';
import type { ShellState, ShellStore, ShellStoreOptions, SliceTools } from './types';
import { uiSlice } from './ui';

export { TILING_SPACING } from './desktop';
export type {
  ClosingChoice,
  DeletedPreset,
  DragState,
  DragSubject,
  DragSurroundings,
  LayoutsIntent,
  Overlay,
  RemovedVariable,
  ShellDropTarget,
  ShellState,
  ShellStore,
  ShellStoreOptions,
  WorkspaceClosing,
} from './types';

/** Creates the state of one shell. */
export function createShellStore(options: ShellStoreOptions = {}): ShellStore {
  let counter = 0;

  return createStore<ShellState>()((set, get) => {
    const tools: SliceTools = {
      set,
      get,
      options,
      setDesktop: (desktop: Desktop<WindowPayload>) => {
        if (desktop !== get().desktop) {
          set({ desktop });
        }
      },
      newWindowId: (kind: string): WindowId => {
        const { windows } = get().desktop;
        let id: WindowId;

        do {
          counter += 1;
          id = `${kind}-${counter}`;
        } while (windows.has(id));

        return id;
      },
    };

    return {
      ...desktopSlice(tools),
      ...layoutsSlice(tools),
      ...uiSlice(tools),
      ...dragSlice(tools),
      ...commandsSlice(tools),
    };
  });
}

/** Carries the shell's store to its components. */
export const ShellStoreContext = createContext<ShellStore | null>(null);

/**
 * Reads the shell's state.
 *
 * @throws {Error} Outside of a `ShellStoreContext`.
 */
export function useShell<T>(selector: (state: ShellState) => T): T {
  const store = use(ShellStoreContext);

  if (store === null) {
    throw new Error('useShell needs a ShellStoreContext above it');
  }

  return useStore(store, selector);
}

/**
 * The shell's store itself, for handlers that read the latest state when they run.
 *
 * @throws {Error} Outside of a `ShellStoreContext`.
 */
export function useShellStore(): ShellStore {
  const store = use(ShellStoreContext);

  if (store === null) {
    throw new Error('useShellStore needs a ShellStoreContext above it');
  }

  return store;
}
