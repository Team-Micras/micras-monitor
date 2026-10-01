/**
 * The UI state of the shell: the desktop of windows, the viewport it is laid out in, the theme,
 * which overlay is open, drags in progress and the keymap. Robot data stays in the monitor.
 *
 * @module
 */

import { createContext, use } from 'react';
import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';

import type { CommandSpec, LayoutPreset } from '@/robot-kit';
import {
  activeWorkspace,
  applyDrop,
  createDesktop,
  containsPoint,
  execute,
  hitTest,
  layoutWorkspace,
  placeFloating,
  resizeCorner,
  resizeSplit,
  usableBounds,
  type Command,
  type CornerSplits,
  type Desktop,
  type DropTarget,
  type EdgePlacement,
  type LayoutMetrics,
  type NodePath,
  type Point,
  type Rect,
  type WindowId,
} from '@/tiling';

import { resolveBindings, type KeyBindings, type KeyOverrides } from '../keymap/keymap';
import { presetWorkspace, workspacePreset } from '../layouts/presets';
import type { CommandNotice } from '../lib/command-outcome';
import { PLOT_KIND, windowKind } from '../windows/registry';
import type { WindowPayload } from '../windows/types';
import { defaultDesktop } from './default-desktop';
import type { Theme } from './theme';

/** Spacing of the tiling, from the approved design. */
export const TILING_SPACING = { gap: 14, outerGap: 14, minWidth: 220, minHeight: 140 } as const;

/** A panel over the tiling, at most one at a time. */
export type Overlay = 'launcher' | 'drawer' | null;

/** What is being dragged: a window by its title, or a variable from the drawer. */
export type DragSubject =
  | { readonly kind: 'window'; readonly id: WindowId }
  | { readonly kind: 'variable'; readonly name: string };

/**
 * Where a drag would land: a target of the engine, or `new`, a window of its own for a variable
 * dropped on an empty workspace.
 */
export type ShellDropTarget = DropTarget | { readonly kind: 'new'; readonly preview: Rect };

/** A drag in progress. */
export interface DragState {
  readonly subject: DragSubject;
  /** The pointer, in client pixels. */
  readonly pointer: Point;
  readonly target: ShellDropTarget | null;
  /** Where a floating window was grabbed, from its top-left corner. */
  readonly grab: Point | null;
}

/** What is under the pointer during a drag, outside of the tiling's own geometry. */
export interface DragSurroundings {
  /** The workspace tab under the pointer, or null. */
  readonly tab: number | null;
  /** Whether the pointer is over the tiling itself, not over a panel in front of it. */
  readonly overTiling: boolean;
}

/** What the layouts menu is opened to do: name a new preset, or rename one of the user's. */
export type LayoutsIntent =
  | { readonly kind: 'save' }
  | { readonly kind: 'rename'; readonly name: string };

/**
 * A workspace about to be closed, waiting for the user to say what becomes of its windows: close
 * them too, or move them to another workspace. It names the workspace, whose place in the list
 * can change while the question is open. `windows` is the choice the question starts on.
 */
export interface WorkspaceClosing {
  readonly name: string;
  readonly windows: 'close' | 'move';
}

/** What becomes of a closing workspace's windows: closed with it, or moved to a named workspace. */
export type ClosingChoice = 'close' | { readonly moveTo: string };

/** A preset the user deleted, kept for a moment so that the deletion can be undone. */
export interface DeletedPreset {
  /** Tells one deletion from the next. */
  readonly id: number;
  readonly preset: LayoutPreset;
  /** Where it was in the list. */
  readonly index: number;
}

/** A variable the user took out of a window, kept for a moment so that it can be put back. */
export interface RemovedVariable {
  /** Tells one removal from the next. */
  readonly id: number;
  readonly window: WindowId;
  readonly name: string;
  /** Where it was among the window's variables. */
  readonly index: number;
}

/** The shell's state and what changes it. */
export interface ShellState {
  readonly desktop: Desktop<WindowPayload>;
  readonly metrics: LayoutMetrics;
  /** The tiling's top-left corner in client pixels, which turns pointer events into its space. */
  readonly origin: Point;
  readonly theme: Theme;
  readonly overlay: Overlay;
  readonly connectionOpen: boolean;
  /** Whether the layouts menu is open. */
  readonly layoutsOpen: boolean;
  /** What the layouts menu was opened for, or null when for browsing. */
  readonly layoutsIntent: LayoutsIntent | null;
  /** The presets the user made for the connected robot; they are saved with its layout. */
  readonly presets: readonly LayoutPreset[];
  /**
   * The preset deleted last, until the notice about it times out or is dismissed. Only the last
   * removal can be undone, so this and {@link ShellState.removedVariable} are never both set.
   */
  readonly deletedPreset: DeletedPreset | null;
  /** The variable taken out of a window last, until the notice about it times out. */
  readonly removedVariable: RemovedVariable | null;
  readonly paused: ReadonlySet<WindowId>;
  readonly keyOverrides: KeyOverrides;
  /**
   * The commands of the robot package seen last, which their keys and the pinned buttons stay
   * bound to after the robot is gone, so that a press says there is no robot.
   */
  readonly commands: readonly CommandSpec[];
  readonly bindings: KeyBindings;
  readonly drag: DragState | null;
  /** The workspace whose closing waits for the user's choice, or null. */
  readonly closingWorkspace: WorkspaceClosing | null;
  /** How many commands each window has sent that still wait for the robot's answer. */
  readonly waitingCommands: ReadonlyMap<WindowId, number>;
  /** Whether a gap is being dragged, which turns off the windows' transitions. */
  readonly resizing: boolean;
  /** What the last command sent from the shell came to, shown until it times out. */
  readonly commandNotice: CommandNotice | null;

  /** Carries out a tiling command. */
  readonly run: (command: Command<WindowPayload>) => void;
  /** Sets where the tiling is on screen and how large it is. */
  readonly setViewport: (rect: Rect) => void;
  /**
   * Opens a window on the active workspace and focuses it.
   *
   * @returns Its id.
   */
  readonly openWindow: (
    kind: string,
    variables?: readonly string[],
    at?: EdgePlacement
  ) => WindowId;
  /** Adds a variable to a window that shows variables, once. */
  readonly addVariable: (id: WindowId, name: string) => void;
  /**
   * Takes a variable out of a window, which {@link ShellState.undoRemoveVariable} puts back. The
   * window stays, even with no variable left.
   */
  readonly removeVariable: (id: WindowId, name: string) => void;
  /** Puts the variable removed last back where it was, if its window is still open. */
  readonly undoRemoveVariable: () => void;
  /** Forgets the removed variable of a notice, if it is still the one kept. */
  readonly clearRemovedVariable: (id: number) => void;
  /** Adds a workspace with a name no other has, and shows it. */
  readonly addWorkspace: () => void;
  /**
   * Closes a workspace, asking first what becomes of its windows: an empty one closes at once, and
   * the last one never does.
   *
   * @param windows What the question starts on: closing the windows, or moving them.
   */
  readonly requestCloseWorkspace: (index: number, windows: WorkspaceClosing['windows']) => void;
  /**
   * Answers the question {@link ShellState.requestCloseWorkspace} asked, finding both workspaces
   * by name as they are now. Nothing is closed when either is gone or they are the same.
   */
  readonly confirmCloseWorkspace: (choice: ClosingChoice) => void;
  /** Dismisses the question {@link ShellState.requestCloseWorkspace} asked. */
  readonly cancelCloseWorkspace: () => void;
  /**
   * Counts a command of a window that is waiting for the robot's answer, or one that got it.
   *
   * @param change 1 when a command is sent, -1 when its answer comes.
   */
  readonly trackCommand: (id: WindowId, change: 1 | -1) => void;
  /** Sets a split's ratio from a gap being dragged. */
  readonly resizeSplit: (path: NodePath, ratio: number) => void;
  /** Moves the two splits that meet at a window's corner so that their gaps cross at a point. */
  readonly resizeCorner: (splits: CornerSplits, point: Point) => void;
  readonly setResizing: (resizing: boolean) => void;
  /** Moves or resizes a floating window, in tiling pixels. */
  readonly placeFloating: (id: WindowId, rect: Rect) => void;
  readonly togglePause: (id: WindowId) => void;
  /** Pauses a window, as scrolling it back in time does, or makes it follow the live end again. */
  readonly setPaused: (id: WindowId, paused: boolean) => void;
  readonly setTheme: (theme: Theme) => void;
  readonly toggleTheme: () => void;
  /** Opens an overlay, or closes it with null or when it is the one open and `toggle` is set. */
  readonly setOverlay: (overlay: Overlay, toggle?: boolean) => void;
  readonly setConnectionOpen: (open: boolean) => void;
  /**
   * Opens or closes the layouts menu.
   *
   * @param intent What it is opened for, when opening.
   */
  readonly setLayoutsOpen: (open: boolean, intent?: LayoutsIntent | null) => void;
  /** Replaces the desktop and the user's presets, as when another robot's layout is loaded. */
  readonly loadLayout: (desktop: Desktop<WindowPayload>, presets: readonly LayoutPreset[]) => void;
  /** Adds a workspace built from a preset, named after it, and shows it. */
  readonly applyPreset: (preset: LayoutPreset) => void;
  /**
   * Saves the active workspace as one of the user's presets, replacing the one of that name.
   *
   * @returns Whether it was saved; a blank name is not.
   */
  readonly savePreset: (name: string) => boolean;
  /**
   * Renames one of the user's presets.
   *
   * @returns Whether it was renamed; not when the new name is blank or another preset has it.
   */
  readonly renamePreset: (name: string, next: string) => boolean;
  /** Deletes one of the user's presets, which {@link ShellState.undoDelete} brings back. */
  readonly deletePreset: (name: string) => void;
  /** Puts the preset deleted last back where it was, unless its name was taken since. */
  readonly undoDelete: () => void;
  /** Forgets the deleted preset of a notice, if it is still the one kept. */
  readonly clearDeleted: (id: number) => void;
  readonly setKeyOverrides: (overrides: KeyOverrides) => void;
  /** Binds the keys of a robot package's commands, replacing those of the package before. */
  readonly setCommands: (commands: readonly CommandSpec[]) => void;
  readonly beginDrag: (subject: DragSubject, pointer: Point) => void;
  readonly moveDrag: (pointer: Point, surroundings: DragSurroundings) => void;
  /** Drops what is dragged on its target, if any. */
  readonly endDrag: () => void;
  readonly cancelDrag: () => void;
  /** Shows a notice about a command, unless a newer press already has one. */
  readonly showCommandNotice: (notice: CommandNotice) => void;
  /** Hides the notice of a press, if it is still the one shown. */
  readonly clearCommandNotice: (id: number) => void;
}

/** A store of the shell's state. */
export type ShellStore = StoreApi<ShellState>;

/** What a new store starts with; anything omitted takes the defaults. */
export interface ShellStoreOptions {
  readonly desktop?: Desktop<WindowPayload>;
  readonly theme?: Theme;
  readonly keyOverrides?: KeyOverrides;
  readonly viewport?: Rect;
  readonly presets?: readonly LayoutPreset[];
}

/** Creates the state of one shell. */
export function createShellStore(options: ShellStoreOptions = {}): ShellStore {
  let counter = 0;
  let removals = 0;

  return createStore<ShellState>()((set, get) => {
    const update = (desktop: Desktop<WindowPayload>) => {
      if (desktop !== get().desktop) {
        set({ desktop });
      }
    };

    const local = (pointer: Point): Point => {
      const { origin } = get();
      return { x: pointer.x - origin.x, y: pointer.y - origin.y };
    };

    const nextId = (kind: string): WindowId => {
      const { windows } = get().desktop;
      let id: WindowId;

      do {
        counter += 1;
        id = `${kind}-${counter}`;
      } while (windows.has(id));

      return id;
    };

    const floatingRect = (id: WindowId): Rect | null =>
      activeWorkspace(get().desktop).floating.find((entry) => entry.id === id)?.rect ?? null;

    const targetFor = (
      subject: DragSubject,
      pointer: Point,
      surroundings: DragSurroundings
    ): ShellDropTarget | null => {
      const { desktop, metrics } = get();

      if (surroundings.tab !== null && subject.kind === 'window') {
        return surroundings.tab === desktop.active
          ? null
          : { kind: 'workspace', index: surroundings.tab };
      }

      if (!surroundings.overTiling) {
        return null;
      }

      const point = local(pointer);
      const dragged = subject.kind === 'window' ? subject.id : null;
      const target = hitTest(desktop, dragged, point, metrics);

      if (subject.kind === 'variable') {
        const floating = layoutWorkspace(activeWorkspace(desktop), metrics).windows.findLast(
          (window) => window.visible && window.floating && containsPoint(window.rect, point)
        );

        if (floating !== undefined) {
          return windowKind(desktop.windows.get(floating.id)?.kind ?? '').acceptsVariables
            ? { kind: 'center', id: floating.id, preview: floating.rect }
            : null;
        }

        if (target === null) {
          return activeWorkspace(desktop).root === null
            ? { kind: 'new', preview: usableBounds(metrics) }
            : null;
        }

        return target.kind === 'center' &&
          !windowKind(desktop.windows.get(target.id)?.kind ?? '').acceptsVariables
          ? null
          : target;
      }

      return target;
    };

    return {
      desktop: options.desktop ?? defaultDesktop(),
      metrics: {
        ...TILING_SPACING,
        width: options.viewport?.width ?? 1280,
        height: options.viewport?.height ?? 800,
      },
      origin: { x: options.viewport?.x ?? 0, y: options.viewport?.y ?? 0 },
      theme: options.theme ?? 'dark',
      overlay: null,
      connectionOpen: false,
      layoutsOpen: false,
      layoutsIntent: null,
      presets: options.presets ?? [],
      deletedPreset: null,
      removedVariable: null,
      paused: new Set(),
      keyOverrides: options.keyOverrides ?? {},
      commands: [],
      bindings: resolveBindings(options.keyOverrides),
      drag: null,
      closingWorkspace: null,
      waitingCommands: new Map(),
      resizing: false,
      commandNotice: null,

      run: (command) => update(execute(get().desktop, command, get().metrics)),

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
        const id = nextId(kind);
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

      trackCommand: (id, change) => {
        const waiting = new Map(get().waitingCommands);
        const count = (waiting.get(id) ?? 0) + change;

        if (count > 0) {
          waiting.set(id, count);
        } else {
          waiting.delete(id);
        }

        set({ waitingCommands: waiting });
      },

      resizeSplit: (path, ratio) => update(resizeSplit(get().desktop, path, ratio, get().metrics)),

      resizeCorner: (splits, point) =>
        update(resizeCorner(get().desktop, splits, point, get().metrics)),

      setResizing: (resizing) => set({ resizing }),

      placeFloating: (id, rect) => update(placeFloating(get().desktop, id, rect, get().metrics)),

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

      setTheme: (theme) => set({ theme }),

      toggleTheme: () => set({ theme: get().theme === 'dark' ? 'light' : 'dark' }),

      setOverlay: (overlay, toggle = false) =>
        set({ overlay: toggle && get().overlay === overlay ? null : overlay }),

      setConnectionOpen: (connectionOpen) => set({ connectionOpen }),

      setLayoutsOpen: (layoutsOpen, intent = null) =>
        set({ layoutsOpen, layoutsIntent: layoutsOpen ? intent : null }),

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

        const { workspace, windows } = presetWorkspace(preset, name, nextId);
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
            presets: kept
              ? presets.toSpliced(deletedPreset.index, 0, deletedPreset.preset)
              : presets,
            deletedPreset: null,
          });
        }
      },

      clearDeleted: (id) => {
        if (get().deletedPreset?.id === id) {
          set({ deletedPreset: null });
        }
      },

      setKeyOverrides: (keyOverrides) =>
        set({ keyOverrides, bindings: resolveBindings(keyOverrides, get().commands) }),

      setCommands: (commands) =>
        set({ commands, bindings: resolveBindings(get().keyOverrides, commands) }),

      beginDrag: (subject, pointer) => {
        const rect = subject.kind === 'window' ? floatingRect(subject.id) : null;
        const point = local(pointer);
        const grab = rect === null ? null : { x: point.x - rect.x, y: point.y - rect.y };
        set({ drag: { subject, pointer, target: null, grab } });
      },

      moveDrag: (pointer, surroundings) => {
        const { drag } = get();

        if (drag === null) {
          return;
        }

        const { subject, grab } = drag;

        if (subject.kind === 'window' && grab !== null && surroundings.tab === null) {
          const rect = floatingRect(subject.id);

          if (rect !== null) {
            const point = local(pointer);
            get().placeFloating(subject.id, { ...rect, x: point.x - grab.x, y: point.y - grab.y });
          }

          set({ drag: { ...drag, pointer, target: null } });
          return;
        }

        set({ drag: { ...drag, pointer, target: targetFor(subject, pointer, surroundings) } });
      },

      endDrag: () => {
        const { drag, desktop, metrics } = get();
        set({ drag: null });

        if (drag?.target == null) {
          return;
        }

        const { subject, target } = drag;

        if (subject.kind === 'window') {
          if (target.kind !== 'new' && desktop.windows.has(subject.id)) {
            update(applyDrop(desktop, subject.id, target, metrics));
          }

          return;
        }

        switch (target.kind) {
          case 'center':
            get().addVariable(target.id, subject.name);
            get().run({ type: 'focusWindow', id: target.id });
            return;
          case 'edge':
            get().openWindow(PLOT_KIND, [subject.name], { target: target.id, side: target.side });
            return;
          case 'new':
            get().openWindow(PLOT_KIND, [subject.name]);
            return;
          case 'workspace':
            return;
        }
      },

      cancelDrag: () => set({ drag: null }),

      showCommandNotice: (notice) => {
        const current = get().commandNotice;

        if (current === null || notice.id >= current.id) {
          set({ commandNotice: notice });
        }
      },

      clearCommandNotice: (id) => {
        if (get().commandNotice?.id === id) {
          set({ commandNotice: null });
        }
      },
    };
  });
}

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
