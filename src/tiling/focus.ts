/**
 * Geometric focus: the window physically on one side of another, and the reading order.
 *
 * Between tiled windows the edge rule applies. A candidate must start beyond the origin's edge on
 * that side (within 1 px), and candidates are ranked by, in order:
 * 1. overlap on the other axis: a candidate sharing a band with the origin beats one that does not;
 * 2. the nearest edge;
 * 3. the closest center on the other axis;
 * 4. the most recently focused, then tree order.
 *
 * Floating windows overlap everything, so edges say nothing about them and the center rule
 * applies instead. A candidate's center must lie beyond the origin's center in that direction, and
 * candidates are ranked by: inside the 90° cone around the direction first, then the closest
 * center, then the most recently focused. From a floating window the center rule covers every
 * visible window. From a tiled window the tiled windows are searched first by the edge rule, and
 * the floating ones by the center rule only when no tiled window qualifies.
 *
 * @module
 */

import type { PlacedWindow, WorkspaceLayout } from './layout';
import type { Direction, Rect, WindowId } from './types';

type Score = (origin: Rect, candidate: Rect, direction: Direction) => readonly number[] | null;

const TOLERANCE = 1;

/**
 * Finds the visible window physically next to another one in a direction.
 *
 * @param windows The placed windows of a workspace.
 * @param from The window to start from; it must be visible.
 * @param direction Where to look.
 * @param recency Focus history, most recent first, used to break ties.
 * @returns The neighbor, or null when nothing lies that way.
 */
export function findNeighbor(
  windows: readonly PlacedWindow[],
  from: WindowId,
  direction: Direction,
  recency: readonly WindowId[] = []
): WindowId | null {
  const visible = windows.filter((window) => window.visible);
  const origin = visible.find((window) => window.id === from);

  if (origin === undefined) {
    return null;
  }

  const others = visible.filter((window) => window.id !== from);

  if (origin.floating) {
    return best(others, origin.rect, direction, centerScore, recency);
  }

  return (
    best(
      others.filter((window) => !window.floating),
      origin.rect,
      direction,
      edgeScore,
      recency
    ) ??
    best(
      others.filter((window) => window.floating),
      origin.rect,
      direction,
      centerScore,
      recency
    )
  );
}

function best(
  candidates: readonly PlacedWindow[],
  origin: Rect,
  direction: Direction,
  score: Score,
  recency: readonly WindowId[]
): WindowId | null {
  const ranked = candidates
    .map((candidate) => ({ id: candidate.id, key: score(origin, candidate.rect, direction) }))
    .filter((entry): entry is { id: WindowId; key: readonly number[] } => entry.key !== null)
    .map(({ id, key }) => ({ id, key: [...key, recencyRank(recency, id)] }))
    .toSorted((a, b) => compareKeys(a.key, b.key));
  return ranked[0]?.id ?? null;
}

function edgeScore(origin: Rect, candidate: Rect, direction: Direction): readonly number[] | null {
  const distance = edgeDistance(origin, candidate, direction);

  if (distance < -TOLERANCE) {
    return null;
  }

  const overlaps = overlapAcross(origin, candidate, direction) > 0;
  const offset = Math.abs(centerAcross(candidate, direction) - centerAcross(origin, direction));
  return [overlaps ? 0 : 1, Math.max(0, distance), offset];
}

function centerScore(
  origin: Rect,
  candidate: Rect,
  direction: Direction
): readonly number[] | null {
  const along =
    signOf(direction) * (centerAlong(candidate, direction) - centerAlong(origin, direction));

  if (along <= TOLERANCE) {
    return null;
  }

  const across = Math.abs(centerAcross(candidate, direction) - centerAcross(origin, direction));
  return [across <= along ? 0 : 1, Math.hypot(along, across)];
}

function edgeDistance(origin: Rect, candidate: Rect, direction: Direction): number {
  switch (direction) {
    case 'left':
      return origin.x - (candidate.x + candidate.width);
    case 'right':
      return candidate.x - (origin.x + origin.width);
    case 'up':
      return origin.y - (candidate.y + candidate.height);
    default:
      return candidate.y - (origin.y + origin.height);
  }
}

function overlapAcross(a: Rect, b: Rect, direction: Direction): number {
  if (isHorizontal(direction)) {
    return Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  }

  return Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
}

function centerAlong(rect: Rect, direction: Direction): number {
  return isHorizontal(direction) ? rect.x + rect.width / 2 : rect.y + rect.height / 2;
}

function centerAcross(rect: Rect, direction: Direction): number {
  return isHorizontal(direction) ? rect.y + rect.height / 2 : rect.x + rect.width / 2;
}

function isHorizontal(direction: Direction): boolean {
  return direction === 'left' || direction === 'right';
}

function signOf(direction: Direction): number {
  return direction === 'left' || direction === 'up' ? -1 : 1;
}

function recencyRank(recency: readonly WindowId[], id: WindowId): number {
  const index = recency.indexOf(id);
  return index === -1 ? recency.length : index;
}

function compareKeys(a: readonly number[], b: readonly number[]): number {
  const index = a.findIndex((value, i) => value !== b[i]);
  return index === -1 ? 0 : a[index] - b[index];
}

/**
 * Lists the visible windows of a workspace in reading order, the order Tab should follow: tiled
 * windows by the top edge, then the left edge (both rounded to the pixel), then floating windows
 * by the same rule. Windows hidden behind a maximized one are left out.
 */
export function readingOrder(layout: WorkspaceLayout): WindowId[] {
  const visible = layout.windows.filter((window) => window.visible);
  return [
    ...byPosition(visible.filter((window) => !window.floating)),
    ...byPosition(visible.filter((window) => window.floating)),
  ].map((window) => window.id);
}

function byPosition(windows: readonly PlacedWindow[]): readonly PlacedWindow[] {
  return windows.toSorted(
    (a, b) =>
      Math.round(a.rect.y) - Math.round(b.rect.y) || Math.round(a.rect.x) - Math.round(b.rect.x)
  );
}
