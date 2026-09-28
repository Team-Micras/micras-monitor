/**
 * Turns a workspace into rects for a viewport.
 *
 * Minimum sizes nest: along one axis, a split needs the sum of what its children need plus a gap
 * when it divides that axis, and the larger of the two when it divides the other one. Stored
 * ratios are intent; layout clamps them, so a smaller viewport never rewrites the saved layout.
 *
 * When the minimums cannot fit, the rule is, per split:
 * 1. if both sides fit, the ratio is clamped so each side keeps its nested minimum;
 * 2. otherwise, if the gaps fit, gaps stay exact and the rest is shared in proportion to the
 *    window space each side needs, so every window along that axis shrinks by the same factor;
 * 3. otherwise the space is shared in proportion to the number of windows along the axis, gaps
 *    shrink to what is left, and rects stay inside the viewport without overlapping.
 *
 * @module
 */

import {
  checkMetrics,
  clamp,
  extentAlong,
  keepInside,
  minimumAlong,
  usableBounds,
} from './geometry';
import { firstLeafId } from './tree';
import type {
  Desktop,
  LayoutMetrics,
  NodePath,
  Orientation,
  Point,
  Rect,
  SplitNode,
  TileNode,
  WindowId,
  Workspace,
} from './types';

/** The draggable gap between the two children of a split. */
export interface Gutter {
  readonly path: NodePath;
  readonly orientation: Orientation;
  /** The gap itself, the hit area for resizing. */
  readonly rect: Rect;
  /** The whole split, which turns a pointer position into a ratio. */
  readonly span: Rect;
  /** The ratio in effect, after clamping. */
  readonly ratio: number;
  /** The lowest and highest ratios that keep both sides at their nested minimum. */
  readonly minRatio: number;
  readonly maxRatio: number;
  /** The first window on each side, for accessible labels. */
  readonly between: readonly [WindowId, WindowId];
}

/** The rects of a split tree's tiles and its gutters. */
export interface TreeLayout {
  readonly tiles: ReadonlyMap<WindowId, Rect>;
  readonly gutters: readonly Gutter[];
}

/** Where a window is drawn and whether it can be seen. */
export interface PlacedWindow {
  readonly id: WindowId;
  readonly rect: Rect;
  readonly floating: boolean;
  /** False for tiled windows behind a maximized one; they keep their tile rect. */
  readonly visible: boolean;
}

/** The computed geometry of a workspace. */
export interface WorkspaceLayout {
  /** The viewport without the outer gap. */
  readonly bounds: Rect;
  /** Tiled windows in tree order, then floating windows in stacking order. */
  readonly windows: readonly PlacedWindow[];
  /** Gutters of the tiling; none while a window is maximized. */
  readonly gutters: readonly Gutter[];
}

/** The smallest size of a tree that keeps every window at the minimum and every gap exact. */
export interface MinimumSize {
  readonly width: number;
  readonly height: number;
}

interface AxisNeed {
  readonly gaps: number;
  readonly content: number;
}

interface Division {
  readonly first: number;
  readonly gap: number;
  readonly second: number;
  readonly min: number;
  readonly max: number;
}

/** The smallest size a tree needs; an empty tree needs nothing. */
export function minimumSize(node: TileNode | null, metrics: LayoutMetrics): MinimumSize {
  checkMetrics(metrics);

  if (node === null) {
    return { width: 0, height: 0 };
  }

  return {
    width: totalOf(needAlong(node, 'row', metrics), metrics.gap),
    height: totalOf(needAlong(node, 'column', metrics), metrics.gap),
  };
}

function needAlong(node: TileNode, orientation: Orientation, metrics: LayoutMetrics): AxisNeed {
  if (node.type === 'leaf') {
    return { gaps: 0, content: minimumAlong(metrics, orientation) };
  }

  const first = needAlong(node.first, orientation, metrics);
  const second = needAlong(node.second, orientation, metrics);

  if (node.orientation === orientation) {
    return { gaps: first.gaps + second.gaps + 1, content: first.content + second.content };
  }

  const gaps = Math.max(first.gaps, second.gaps);
  const total = Math.max(totalOf(first, metrics.gap), totalOf(second, metrics.gap));
  return { gaps, content: total - gaps * metrics.gap };
}

function totalOf(need: AxisNeed, gap: number): number {
  return need.gaps * gap + need.content;
}

function divide(node: SplitNode, extent: number, metrics: LayoutMetrics): Division {
  const gap = Math.min(metrics.gap, extent);
  const available = extent - gap;
  const [min, max] = firstExtentRange(
    needAlong(node.first, node.orientation, metrics),
    needAlong(node.second, node.orientation, metrics),
    available,
    metrics.gap
  );
  const first = clamp(Math.round(available * node.ratio), min, max);
  return { first, gap, second: available - first, min, max };
}

function firstExtentRange(
  first: AxisNeed,
  second: AxisNeed,
  available: number,
  gap: number
): readonly [number, number] {
  const firstTotal = totalOf(first, gap);
  const secondTotal = totalOf(second, gap);

  if (firstTotal + secondTotal <= available) {
    return [firstTotal, available - secondTotal];
  }

  const extent =
    (first.gaps + second.gaps) * gap <= available
      ? shrunkExtent(first, second, available, gap)
      : collapsedExtent(first, second, available);
  return [extent, extent];
}

function shrunkExtent(first: AxisNeed, second: AxisNeed, available: number, gap: number): number {
  const content = available - (first.gaps + second.gaps) * gap;
  const share = Math.round((content * first.content) / (first.content + second.content));
  return clamp(first.gaps * gap + share, first.gaps * gap, available - second.gaps * gap);
}

function collapsedExtent(first: AxisNeed, second: AxisNeed, available: number): number {
  return Math.round((available * (first.gaps + 1)) / (first.gaps + second.gaps + 2));
}

/** Lays out a split tree in the viewport's usable bounds. */
export function layoutTree(root: TileNode | null, metrics: LayoutMetrics): TreeLayout {
  checkMetrics(metrics);
  const tiles = new Map<WindowId, Rect>();
  const gutters: Gutter[] = [];

  if (root !== null) {
    place(root, usableBounds(metrics), '', metrics, tiles, gutters);
  }

  return { tiles, gutters };
}

function place(
  node: TileNode,
  rect: Rect,
  path: NodePath,
  metrics: LayoutMetrics,
  tiles: Map<WindowId, Rect>,
  gutters: Gutter[]
): void {
  if (node.type === 'leaf') {
    tiles.set(node.id, rect);
    return;
  }

  const division = divide(node, extentAlong(rect, node.orientation), metrics);
  const [first, gap, second] = splitRect(rect, node.orientation, division);
  gutters.push(gutterOf(node, path, rect, gap, division));
  place(node.first, first, `${path}0`, metrics, tiles, gutters);
  place(node.second, second, `${path}1`, metrics, tiles, gutters);
}

function gutterOf(
  node: SplitNode,
  path: NodePath,
  span: Rect,
  rect: Rect,
  division: Division
): Gutter {
  const available = division.first + division.second;
  const toRatio = (extent: number) => (available > 0 ? extent / available : 0.5);
  return {
    path,
    orientation: node.orientation,
    rect,
    span,
    ratio: toRatio(division.first),
    minRatio: toRatio(division.min),
    maxRatio: toRatio(division.max),
    between: [firstLeafId(node.first), firstLeafId(node.second)],
  };
}

function splitRect(
  rect: Rect,
  orientation: Orientation,
  { first, gap, second }: Division
): readonly [Rect, Rect, Rect] {
  if (orientation === 'row') {
    return [
      { ...rect, width: first },
      { ...rect, x: rect.x + first, width: gap },
      { ...rect, x: rect.x + first + gap, width: second },
    ];
  }

  return [
    { ...rect, height: first },
    { ...rect, y: rect.y + first, height: gap },
    { ...rect, y: rect.y + first + gap, height: second },
  ];
}

/**
 * Fits a floating window's rect to the viewport: at least the minimum size where the bounds
 * allow it, at most the bounds, and moved inside them.
 */
export function fitFloating(rect: Rect, metrics: LayoutMetrics): Rect {
  const bounds = usableBounds(metrics);
  const width = clamp(rect.width, Math.min(metrics.minWidth, bounds.width), bounds.width);
  const height = clamp(rect.height, Math.min(metrics.minHeight, bounds.height), bounds.height);
  return keepInside({ ...rect, width, height }, bounds);
}

/**
 * Computes where every window of a workspace is drawn. A maximized window covers the usable
 * bounds; the other tiled windows keep their tile rect but are hidden, so restoring can animate
 * them back from where they were. Floating windows are fitted to the viewport.
 */
export function layoutWorkspace(workspace: Workspace, metrics: LayoutMetrics): WorkspaceLayout {
  const bounds = usableBounds(metrics);
  const { tiles, gutters } = layoutTree(workspace.root, metrics);
  const maximized =
    workspace.maximized !== null && tiles.has(workspace.maximized) ? workspace.maximized : null;
  const tiled = [...tiles].map(([id, rect]): PlacedWindow => ({
    id,
    rect: id === maximized ? bounds : rect,
    floating: false,
    visible: maximized === null || id === maximized,
  }));
  const floating = workspace.floating.map(({ id, rect }): PlacedWindow => ({
    id,
    rect: fitFloating(rect, metrics),
    floating: true,
    visible: true,
  }));
  return { bounds, windows: [...tiled, ...floating], gutters: maximized === null ? gutters : [] };
}

/** A window of any workspace, where it is drawn and whether it is on screen. */
export interface DesktopWindow extends PlacedWindow {
  /** The index of the workspace holding it. */
  readonly workspace: number;
}

/**
 * Lays out every workspace at once, so the app can render one flat list keyed by window id and
 * keep a view mounted when its window changes workspace. Windows of inactive workspaces keep
 * their rect and are not visible.
 */
export function layoutDesktop(desktop: Desktop, metrics: LayoutMetrics): DesktopWindow[] {
  return desktop.workspaces.flatMap((workspace, index) =>
    layoutWorkspace(workspace, metrics).windows.map(
      ({ id, rect, floating, visible }): DesktopWindow => ({
        id,
        rect,
        floating,
        visible: visible && index === desktop.active,
        workspace: index,
      })
    )
  );
}

/**
 * The ratio that puts a gutter's center under a pointer, clamped to the gutter's range.
 */
export function ratioAtPoint(gutter: Gutter, point: Point): number {
  const { orientation, span, rect } = gutter;
  const gap = extentAlong(rect, orientation);
  const available = extentAlong(span, orientation) - gap;

  if (available <= 0) {
    return gutter.ratio;
  }

  const offset = orientation === 'row' ? point.x - span.x : point.y - span.y;
  return clamp((offset - gap / 2) / available, gutter.minRatio, gutter.maxRatio);
}
