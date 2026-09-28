/**
 * The data the tiling engine works on. Every value is immutable: operations return new values and
 * share whatever did not change, so an unchanged workspace keeps its identity.
 *
 * @module
 */

/**
 * Identifier of a window, chosen by the caller and unique across the whole desktop. The engine
 * never looks inside it; the empty string is reserved.
 */
export type WindowId = string;

/**
 * A window as the engine knows it. `kind` and `payload` belong to the caller (which view it shows,
 * what that view is configured with); the engine only carries them along and serializes them.
 */
export interface TilingWindow<P = unknown> {
  readonly id: WindowId;
  readonly kind: string;
  readonly payload: P;
}

/** An axis-aligned rectangle in viewport pixels, origin at the viewport's top-left corner. */
export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** A point in viewport pixels. */
export interface Point {
  readonly x: number;
  readonly y: number;
}

/** A direction for focus and swap, as the arrow keys name them. */
export type Direction = 'left' | 'right' | 'up' | 'down';

/** An edge of a tile, against which a window is placed. */
export type Side = 'left' | 'right' | 'top' | 'bottom';

/**
 * How a split lays out its two children, in CSS flex vocabulary: `row` puts them side by side,
 * `column` stacks them.
 */
export type Orientation = 'row' | 'column';

/**
 * Address of a node in a split tree: the child choices taken from the root, `'0'` for the first
 * child and `'1'` for the second. The root is `''`.
 */
export type NodePath = string;

/** A tile holding one window. */
export interface LeafNode {
  readonly type: 'leaf';
  readonly id: WindowId;
}

/** A tile divided in two. `ratio` is the first child's share of the space, strictly in (0, 1). */
export interface SplitNode {
  readonly type: 'split';
  readonly orientation: Orientation;
  readonly ratio: number;
  readonly first: TileNode;
  readonly second: TileNode;
}

/** A node of a workspace's split tree. */
export type TileNode = LeafNode | SplitNode;

/**
 * Where a floating window was tiled before it was lifted: beside the subtree holding exactly the
 * `sibling` windows, on `side`, with `ratio` as the first child's share of that split.
 */
export interface DockMemory {
  readonly sibling: readonly WindowId[];
  readonly side: Side;
  readonly ratio: number;
}

/** A window lifted out of the tiling and drawn above it. */
export interface FloatingWindow {
  readonly id: WindowId;
  readonly rect: Rect;
  /** Where docking puts it back, or null to place it by the dwindle rule. */
  readonly dock: DockMemory | null;
}

/** One virtual desktop: a split tree of tiled windows and a floating layer above it. */
export interface Workspace {
  readonly name: string;
  readonly root: TileNode | null;
  /** Floating windows in stacking order, the topmost last. */
  readonly floating: readonly FloatingWindow[];
  /** Focus history, most recent first; the first entry is the focused window. */
  readonly focus: readonly WindowId[];
  /** A tiled window covering the whole workspace, or null. */
  readonly maximized: WindowId | null;
}

/** The whole window system: every window, every workspace and which workspace is shown. */
export interface Desktop<P = unknown> {
  readonly windows: ReadonlyMap<WindowId, TilingWindow<P>>;
  readonly workspaces: readonly Workspace[];
  readonly active: number;
}

/** The viewport the workspace is laid out in and the spacing rules. */
export interface LayoutMetrics {
  readonly width: number;
  readonly height: number;
  /** Space between two windows. */
  readonly gap: number;
  /** Space between the windows and the viewport's edges. */
  readonly outerGap: number;
  readonly minWidth: number;
  readonly minHeight: number;
}

/** A place beside a tiled window: `side` of `target`'s tile. */
export interface EdgePlacement {
  readonly target: WindowId;
  readonly side: Side;
}
