/**
 * The desktop slice of the shell's state: the windows and workspaces, the viewport they are laid
 * out in, and what the windows hold.
 *
 * @module
 */

import {
  execute,
  placeFloating,
  resizeCorner,
  resizeSplit,
  type Desktop,
  type WindowId,
} from '@/tiling';

import type { WindowPayload } from '../../windows/types';
import { defaultDesktop } from '../default-desktop';
import type { DesktopSlice, SliceTools } from './types';

/** Spacing of the tiling, from the approved design. */
export const TILING_SPACING = { gap: 14, outerGap: 14, minWidth: 220, minHeight: 140 } as const;

function withVariables(
  desktop: Desktop<WindowPayload>,
  id: WindowId,
  variables: readonly string[]
): Desktop<WindowPayload> {
  const window = desktop.windows.get(id);

  if (window === undefined) {
    return desktop;
  }

  const windows = new Map(desktop.windows).set(id, {
    ...window,
    payload: { ...window.payload, variables },
  });
  return { ...desktop, windows };
}

/** Creates the desktop slice. */
export function desktopSlice({
  set,
  get,
  options,
  setDesktop,
  newWindowId,
}: SliceTools): DesktopSlice {
  let removals = 0;

  return {
    desktop: options.desktop ?? defaultDesktop(),
    metrics: {
      ...TILING_SPACING,
      width: options.viewport?.width ?? 1280,
      height: options.viewport?.height ?? 800,
    },
    origin: { x: options.viewport?.x ?? 0, y: options.viewport?.y ?? 0 },
    removedVariable: null,
    paused: new Set(),
    closingWorkspace: null,
    resizing: false,

    run: (command) => setDesktop(execute(get().desktop, command, get().metrics)),

    setViewport: ({ x, y, width, height }) => {
      const { metrics, origin } = get();

      if (
        metrics.width !== width ||
        metrics.height !== height ||
        origin.x !== x ||
        origin.y !== y
      ) {
        set({ metrics: { ...metrics, width, height }, origin: { x, y } });
      }
    },

    openWindow: (kind, variables = [], at) => {
      const id = newWindowId(kind);
      get().run({ type: 'open', window: { id, kind, payload: { variables } }, at });
      return id;
    },

    addVariable: (id, name) => {
      const { desktop } = get();
      const window = desktop.windows.get(id);

      if (window === undefined || window.payload.variables.includes(name)) {
        return;
      }

      set({ desktop: withVariables(desktop, id, [...window.payload.variables, name]) });
    },

    removeVariable: (id, name) => {
      const { desktop } = get();
      const window = desktop.windows.get(id);
      const index = window?.payload.variables.indexOf(name) ?? -1;

      if (window === undefined || index === -1) {
        return;
      }

      removals += 1;
      set({
        desktop: withVariables(desktop, id, window.payload.variables.toSpliced(index, 1)),
        removedVariable: { id: removals, window: id, name, index },
        deletedPreset: null,
      });
    },

    undoRemoveVariable: () => {
      const { desktop, removedVariable: removed } = get();
      const window = removed === null ? undefined : desktop.windows.get(removed.window);

      if (removed === null) {
        return;
      }

      if (window === undefined || window.payload.variables.includes(removed.name)) {
        set({ removedVariable: null });
        return;
      }

      set({
        desktop: withVariables(
          desktop,
          removed.window,
          window.payload.variables.toSpliced(removed.index, 0, removed.name)
        ),
        removedVariable: null,
      });
    },

    clearRemovedVariable: (id) => {
      if (get().removedVariable?.id === id) {
        set({ removedVariable: null });
      }
    },

    addWorkspace: () => {
      const names = new Set(get().desktop.workspaces.map((workspace) => workspace.name));
      let number = names.size + 1;

      while (names.has(`Workspace ${number}`)) {
        number += 1;
      }

      get().run({ type: 'addWorkspace', name: `Workspace ${number}` });
      get().run({ type: 'switchWorkspace', index: get().desktop.workspaces.length - 1 });
    },

    requestCloseWorkspace: (index, windows) => {
      const { workspaces } = get().desktop;
      const workspace = workspaces[index];

      if (workspace === undefined || workspaces.length === 1) {
        return;
      }

      if (workspace.root === null && workspace.floating.length === 0) {
        get().run({ type: 'removeWorkspace', index, policy: 'closeWindows' });
      } else {
        set({ closingWorkspace: { name: workspace.name, windows } });
      }
    },

    confirmCloseWorkspace: (choice) => {
      const { closingWorkspace, desktop } = get();
      set({ closingWorkspace: null });

      if (closingWorkspace === null) {
        return;
      }

      const indexOf = (name: string) =>
        desktop.workspaces.findIndex((workspace) => workspace.name === name);
      const index = indexOf(closingWorkspace.name);
      const into = choice === 'close' ? null : indexOf(choice.moveTo);

      if (index === -1 || into === -1 || into === index) {
        return;
      }

      get().run({
        type: 'removeWorkspace',
        index,
        policy: into === null ? 'closeWindows' : { mergeInto: into },
      });
    },

    cancelCloseWorkspace: () => set({ closingWorkspace: null }),

    resizeSplit: (path, ratio) =>
      setDesktop(resizeSplit(get().desktop, path, ratio, get().metrics)),

    resizeCorner: (splits, point) =>
      setDesktop(resizeCorner(get().desktop, splits, point, get().metrics)),

    setResizing: (resizing) => set({ resizing }),

    placeFloating: (id, rect) => setDesktop(placeFloating(get().desktop, id, rect, get().metrics)),

    togglePause: (id) => {
      const paused = new Set(get().paused);

      if (!paused.delete(id)) {
        paused.add(id);
      }

      set({ paused });
    },

    setPaused: (id, paused) => {
      if (get().paused.has(id) === paused) {
        return;
      }

      const next = new Set(get().paused);

      if (paused) {
        next.add(id);
      } else {
        next.delete(id);
      }

      set({ paused: next });
    },
  };
}
