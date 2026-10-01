/**
 * The layouts slice of the shell's state: the user's presets for the connected robot, and the
 * layout loaded for it.
 *
 * @module
 */

import { createDesktop } from '@/tiling';

import { presetWorkspace, workspacePreset } from '../../layouts/presets';
import type { LayoutsSlice, SliceTools } from './types';

/** Creates the layouts slice. */
export function layoutsSlice({ set, get, options, newWindowId }: SliceTools): LayoutsSlice {
  return {
    presets: options.presets ?? [],
    deletedPreset: null,

    loadLayout: (desktop, presets) =>
      set({
        desktop,
        presets,
        deletedPreset: null,
        removedVariable: null,
        closingWorkspace: null,
        paused: new Set(),
      }),

    applyPreset: (preset) => {
      const { desktop } = get();
      const names = new Set(desktop.workspaces.map((workspace) => workspace.name));
      let name = preset.name;

      for (let number = 2; names.has(name); number += 1) {
        name = `${preset.name} ${number}`;
      }

      const { workspace, windows } = presetWorkspace(preset, name, newWindowId);
      set({
        desktop: createDesktop(
          [...desktop.workspaces, workspace],
          [...desktop.windows.values(), ...windows],
          desktop.workspaces.length
        ),
      });
    },

    savePreset: (name) => {
      const { desktop, presets } = get();
      const trimmed = name.trim();

      if (trimmed === '') {
        return false;
      }

      const preset = workspacePreset(desktop, desktop.active, trimmed);
      set({
        presets: presets.some((entry) => entry.name === trimmed)
          ? presets.map((entry) => (entry.name === trimmed ? preset : entry))
          : [...presets, preset],
      });
      return true;
    },

    renamePreset: (name, next) => {
      const { presets } = get();
      const trimmed = next.trim();

      if (
        trimmed === '' ||
        !presets.some((entry) => entry.name === name) ||
        (trimmed !== name && presets.some((entry) => entry.name === trimmed))
      ) {
        return false;
      }

      set({
        presets: presets.map((entry) =>
          entry.name === name ? { name: trimmed, root: entry.root } : entry
        ),
      });
      return true;
    },

    deletePreset: (name) => {
      const { presets, deletedPreset } = get();
      const index = presets.findIndex((entry) => entry.name === name);

      if (index >= 0) {
        set({
          presets: presets.filter((entry) => entry.name !== name),
          deletedPreset: { id: (deletedPreset?.id ?? 0) + 1, preset: presets[index], index },
          removedVariable: null,
        });
      }
    },

    undoDelete: () => {
      const { presets, deletedPreset } = get();

      if (deletedPreset !== null) {
        const kept = !presets.some((entry) => entry.name === deletedPreset.preset.name);
        set({
          presets: kept ? presets.toSpliced(deletedPreset.index, 0, deletedPreset.preset) : presets,
          deletedPreset: null,
        });
      }
    },

    clearDeleted: (id) => {
      if (get().deletedPreset?.id === id) {
        set({ deletedPreset: null });
      }
    },
  };
}
