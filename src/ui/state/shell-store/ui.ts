/**
 * The UI slice of the shell's state: the theme, and which of the panels and menus over the
 * desktop are open.
 *
 * @module
 */

import type { SliceTools, UiSlice } from './types';

/** Creates the UI slice. */
export function uiSlice({ set, get, options }: SliceTools): UiSlice {
  return {
    theme: options.theme ?? 'dark',
    overlay: null,
    connectionOpen: false,
    layoutsOpen: false,
    layoutsIntent: null,

    setTheme: (theme) => set({ theme }),

    toggleTheme: () => set({ theme: get().theme === 'dark' ? 'light' : 'dark' }),

    setOverlay: (overlay, toggle = false) =>
      set({ overlay: toggle && get().overlay === overlay ? null : overlay }),

    setConnectionOpen: (connectionOpen) => set({ connectionOpen }),

    setLayoutsOpen: (layoutsOpen, intent = null) =>
      set({ layoutsOpen, layoutsIntent: layoutsOpen ? intent : null }),
  };
}
