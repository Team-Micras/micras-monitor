/**
 * The shape of the shell's state, slice by slice, and the types its actions take.
 *
 * @module
 */

import type { StoreApi } from 'zustand/vanilla';

import type { CommandSpec, LayoutPreset } from '@/core/robot';
import type {
  Command,
  CornerSplits,
  Desktop,
  DropTarget,
  EdgePlacement,
  LayoutMetrics,
  NodePath,
  Point,
  Rect,
  WindowId,
} from '@/tiling';

import type { KeyBindings, KeyOverrides } from '../../keyboard/keymap';
import type { CommandNotice } from '../../shell/commands/command-outcome';
import type { WindowPayload } from '../../windows/types';
import type { Theme } from '../theme';

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

/** The desktop of windows, the viewport it is laid out in, and what the windows hold. */
export interface DesktopSlice {
  readonly desktop: Desktop<WindowPayload>;
  readonly metrics: LayoutMetrics;
  /** The tiling's top-left corner in client pixels, which turns pointer events into its space. */
  readonly origin: Point;
  /** The variable taken out of a window last, until the notice about it times out. */
  readonly removedVariable: RemovedVariable | null;
  readonly paused: ReadonlySet<WindowId>;
  /** The workspace whose closing waits for the user's choice, or null. */
  readonly closingWorkspace: WorkspaceClosing | null;
  /** Whether a gap is being dragged, which turns off the windows' transitions. */
  readonly resizing: boolean;

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
   * Takes a variable out of a window, which {@link DesktopSlice.undoRemoveVariable} puts back. The
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
   * Answers the question {@link DesktopSlice.requestCloseWorkspace} asked, finding both workspaces
   * by name as they are now. Nothing is closed when either is gone or they are the same.
   */
  readonly confirmCloseWorkspace: (choice: ClosingChoice) => void;
  /** Dismisses the question {@link DesktopSlice.requestCloseWorkspace} asked. */
  readonly cancelCloseWorkspace: () => void;
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
}

/** The user's layout presets for the connected robot, and the layout loaded for it. */
export interface LayoutsSlice {
  /** The presets the user made for the connected robot; they are saved with its layout. */
  readonly presets: readonly LayoutPreset[];
  /**
   * The preset deleted last, until the notice about it times out or is dismissed. Only the last
   * removal can be undone, so this and {@link DesktopSlice.removedVariable} are never both set.
   */
  readonly deletedPreset: DeletedPreset | null;

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
  /** Deletes one of the user's presets, which {@link LayoutsSlice.undoDelete} brings back. */
  readonly deletePreset: (name: string) => void;
  /** Puts the preset deleted last back where it was, unless its name was taken since. */
  readonly undoDelete: () => void;
  /** Forgets the deleted preset of a notice, if it is still the one kept. */
  readonly clearDeleted: (id: number) => void;
}

/** The theme, and which of the panels and menus over the desktop are open. */
export interface UiSlice {
  readonly theme: Theme;
  readonly overlay: Overlay;
  readonly connectionOpen: boolean;
  /** Whether the layouts menu is open. */
  readonly layoutsOpen: boolean;
  /** What the layouts menu was opened for, or null when for browsing. */
  readonly layoutsIntent: LayoutsIntent | null;

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
}

/** A window or a variable being dragged, and where it would land. */
export interface DragSlice {
  readonly drag: DragState | null;

  readonly beginDrag: (subject: DragSubject, pointer: Point) => void;
  readonly moveDrag: (pointer: Point, surroundings: DragSurroundings) => void;
  /** Drops what is dragged on its target, if any. */
  readonly endDrag: () => void;
  readonly cancelDrag: () => void;
}

/** The robot's commands: their keys, the keymap they join, and how the last ones went. */
export interface CommandsSlice {
  readonly keyOverrides: KeyOverrides;
  /**
   * The commands of the robot package seen last, which their keys and the pinned buttons stay
   * bound to after the robot is gone, so that a press says there is no robot.
   */
  readonly commands: readonly CommandSpec[];
  readonly bindings: KeyBindings;
  /** How many commands each window has sent that still wait for the robot's answer. */
  readonly waitingCommands: ReadonlyMap<WindowId, number>;
  /** What the last command sent from the shell came to, shown until it times out. */
  readonly commandNotice: CommandNotice | null;

  /**
   * Counts a command of a window that is waiting for the robot's answer, or one that got it.
   *
   * @param change 1 when a command is sent, -1 when its answer comes.
   */
  readonly trackCommand: (id: WindowId, change: 1 | -1) => void;
  /**
   * Rebinds keys. Nothing changes when an override takes the chord of a command's key.
   *
   * @returns Why it was refused, or null when it was applied.
   */
  readonly setKeyOverrides: (overrides: KeyOverrides) => string | null;
  /** Binds the keys of a robot package's commands, replacing those of the package before. */
  readonly setCommands: (commands: readonly CommandSpec[]) => void;
  /** Shows a notice about a command, unless a newer press already has one. */
  readonly showCommandNotice: (notice: CommandNotice) => void;
  /** Hides the notice of a press, if it is still the one shown. */
  readonly clearCommandNotice: (id: number) => void;
}

/** The shell's state and what changes it. */
export type ShellState = DesktopSlice & LayoutsSlice & UiSlice & DragSlice & CommandsSlice;

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

/** What every slice is built with: the store's own access, its options and what they share. */
export interface SliceTools {
  readonly set: ShellStore['setState'];
  readonly get: ShellStore['getState'];
  readonly options: ShellStoreOptions;
  /** Sets the desktop, unless it is the one there already. */
  readonly setDesktop: (desktop: Desktop<WindowPayload>) => void;
  /** An id for a new window of a kind that no window on the desktop has. */
  readonly newWindowId: (kind: string) => WindowId;
}
