/**
 * The UI state of the shell: the desktop of windows, the viewport it is laid out in, the theme,
 * which overlay is open, drags in progress and the keymap. Robot data stays behind the ports.
 *
 * @module
 */

import { createContext, use } from 'react';
import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';

import {
  activeWorkspace,
  applyDrop,
  containsPoint,
  execute,
  hitTest,
  layoutWorkspace,
  placeFloating,
  resizeSplit,
  usableBounds,
  type Command,
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
import type { StopNotice } from '../lib/stop-outcome';
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

/** The shell's state and what changes it. */
export interface ShellState {
  readonly desktop: Desktop<WindowPayload>;
  readonly metrics: LayoutMetrics;
  /** The tiling's top-left corner in client pixels, which turns pointer events into its space. */
  readonly origin: Point;
  readonly theme: Theme;
  readonly overlay: Overlay;
  readonly connectionOpen: boolean;
  readonly paused: ReadonlySet<WindowId>;
  readonly keyOverrides: KeyOverrides;
  readonly bindings: KeyBindings;
  readonly drag: DragState | null;
  /** Whether a gap is being dragged, which turns off the windows' transitions. */
  readonly resizing: boolean;
  /** What the last STOP came to, shown under the button until it times out. */
  readonly stopNotice: StopNotice | null;

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
  /** Adds a workspace with a name no other has, and shows it. */
  readonly addWorkspace: () => void;
  /** Sets a split's ratio from a gap being dragged. */
  readonly resizeSplit: (path: NodePath, ratio: number) => void;
  readonly setResizing: (resizing: boolean) => void;
  /** Moves or resizes a floating window, in tiling pixels. */
  readonly placeFloating: (id: WindowId, rect: Rect) => void;
  readonly togglePause: (id: WindowId) => void;
  readonly setTheme: (theme: Theme) => void;
  readonly toggleTheme: () => void;
  /** Opens an overlay, or closes it with null or when it is the one open and `toggle` is set. */
  readonly setOverlay: (overlay: Overlay, toggle?: boolean) => void;
  readonly setConnectionOpen: (open: boolean) => void;
  readonly setKeyOverrides: (overrides: KeyOverrides) => void;
  readonly beginDrag: (subject: DragSubject, pointer: Point) => void;
  readonly moveDrag: (pointer: Point, surroundings: DragSurroundings) => void;
  /** Drops what is dragged on its target, if any. */
  readonly endDrag: () => void;
  readonly cancelDrag: () => void;
  /** Shows a notice about STOP, unless a newer press already has one. */
  readonly showStopNotice: (notice: StopNotice) => void;
  /** Hides the notice of a press, if it is still the one shown. */
  readonly clearStopNotice: (id: number) => void;
}

/** A store of the shell's state. */
export type ShellStore = StoreApi<ShellState>;

/** What a new store starts with; anything omitted takes the defaults. */
export interface ShellStoreOptions {
  readonly desktop?: Desktop<WindowPayload>;
  readonly theme?: Theme;
  readonly keyOverrides?: KeyOverrides;
  readonly viewport?: Rect;
}

/** Creates the state of one shell. */
export function createShellStore(options: ShellStoreOptions = {}): ShellStore {
  let counter = 0;

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
      paused: new Set(),
      keyOverrides: options.keyOverrides ?? {},
      bindings: resolveBindings(options.keyOverrides),
      drag: null,
      resizing: false,
      stopNotice: null,

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

        const payload = { ...window.payload, variables: [...window.payload.variables, name] };
        const windows = new Map(desktop.windows).set(id, { ...window, payload });
        set({ desktop: { ...desktop, windows } });
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

      resizeSplit: (path, ratio) => update(resizeSplit(get().desktop, path, ratio, get().metrics)),

      setResizing: (resizing) => set({ resizing }),

      placeFloating: (id, rect) => update(placeFloating(get().desktop, id, rect, get().metrics)),

      togglePause: (id) => {
        const paused = new Set(get().paused);

        if (!paused.delete(id)) {
          paused.add(id);
        }

        set({ paused });
      },

      setTheme: (theme) => set({ theme }),

      toggleTheme: () => set({ theme: get().theme === 'dark' ? 'light' : 'dark' }),

      setOverlay: (overlay, toggle = false) =>
        set({ overlay: toggle && get().overlay === overlay ? null : overlay }),

      setConnectionOpen: (connectionOpen) => set({ connectionOpen }),

      setKeyOverrides: (keyOverrides) =>
        set({ keyOverrides, bindings: resolveBindings(keyOverrides) }),

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

      showStopNotice: (notice) => {
        const current = get().stopNotice;

        if (current === null || notice.id >= current.id) {
          set({ stopNotice: notice });
        }
      },

      clearStopNotice: (id) => {
        if (get().stopNotice?.id === id) {
          set({ stopNotice: null });
        }
      },
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
