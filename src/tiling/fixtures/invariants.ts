/**
 * The rules every desktop and layout must obey, as lists of violations, shared by the example
 * tests and the randomized ones. An empty list means the rules hold.
 *
 * @module
 */

import { usableBounds } from '../geometry';
import { LayoutError } from '../layout-error';
import { layoutTree, layoutWorkspace, minimumSize } from '../layout';
import type { Desktop, LayoutMetrics, Rect } from '../types';
import { validateDesktop } from '../validate';
import { focusedWindow, windowIds } from '../workspace';

const EPSILON = 1e-6;

/** The space between two rects: positive when apart, negative when they overlap on both axes. */
export function separationOf(a: Rect, b: Rect): number {
  const dx = Math.max(a.x - (b.x + b.width), b.x - (a.x + a.width));
  const dy = Math.max(a.y - (b.y + b.height), b.y - (a.y + a.height));
  return Math.max(dx, dy);
}

/** Rects with a negative size or reaching outside the bounds. */
export function outsideOf(rects: readonly Rect[], bounds: Rect): string[] {
  return rects
    .filter(
      (rect) =>
        rect.width < 0 ||
        rect.height < 0 ||
        rect.x < bounds.x - EPSILON ||
        rect.y < bounds.y - EPSILON ||
        rect.x + rect.width > bounds.x + bounds.width + EPSILON ||
        rect.y + rect.height > bounds.y + bounds.height + EPSILON
    )
    .map((rect) => `${JSON.stringify(rect)} is outside ${JSON.stringify(bounds)}`);
}

/** Pairs of rects closer than `gap`, which includes overlapping ones. */
export function tooCloseOf(rects: readonly Rect[], gap: number): string[] {
  return rects.flatMap((a, i) =>
    rects
      .slice(i + 1)
      .filter((b) => separationOf(a, b) < gap - EPSILON)
      .map((b) => `${JSON.stringify(a)} and ${JSON.stringify(b)} are closer than ${gap}`)
  );
}

/**
 * Checks a desktop and its layout: the structural rules of `validateDesktop`; every window in
 * exactly one workspace; the focused window visible; tiles and floating windows inside the usable
 * bounds; tiles a gap apart; and tiles at the minimum size whenever the tree's minimum fits.
 */
export function violationsOf(desktop: Desktop, metrics: LayoutMetrics): string[] {
  const structural = structuralViolationsOf(desktop);

  if (structural.length > 0) {
    return structural;
  }

  const bounds = usableBounds(metrics);
  return desktop.workspaces.flatMap((workspace, index) => {
    const layout = layoutWorkspace(workspace, metrics);
    const tiles = [...layoutTree(workspace.root, metrics).tiles.values()];
    const focused = focusedWindow(workspace);
    const needed = minimumSize(workspace.root, metrics);
    const fits = needed.width <= bounds.width && needed.height <= bounds.height;
    const small = fits
      ? tiles.filter((t) => t.width < metrics.minWidth - 1 || t.height < metrics.minHeight - 1)
      : [];
    const hidden =
      focused !== null && !layout.windows.some((w) => w.id === focused && w.visible)
        ? [`"${focused}" is focused but not visible`]
        : [];
    return [
      ...hidden,
      ...outsideOf(
        layout.windows.map((w) => w.rect),
        bounds
      ),
      ...tooCloseOf(tiles, metrics.gap),
      ...small.map((t) => `${JSON.stringify(t)} is below the minimum size`),
    ].map((problem) => `workspaces[${index}]: ${problem}`);
  });
}

function structuralViolationsOf(desktop: Desktop): string[] {
  try {
    validateDesktop(desktop);
  } catch (error) {
    return [error instanceof LayoutError ? error.message : String(error)];
  }

  const everywhere = desktop.workspaces.flatMap(windowIds);
  const unique = new Set(everywhere);
  const known = new Set(desktop.windows.keys());
  const same = unique.size === known.size && [...unique].every((id) => known.has(id));
  return unique.size === everywhere.length && same
    ? []
    : ['the windows placed do not match the windows known'];
}
