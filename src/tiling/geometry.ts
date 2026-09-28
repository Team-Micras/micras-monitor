/**
 * Rectangle helpers shared by layout, focus and hit testing.
 *
 * @module
 */

import { LayoutError } from './layout-error';
import type { LayoutMetrics, Orientation, Point, Rect } from './types';

/** The smallest share a split may store for either child; ratios live strictly inside (0, 1). */
export const MIN_RATIO = 0.001;

/** Restricts a value to a range. */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Brings a ratio strictly inside (0, 1), turning anything that is not a number into 0.5. */
export function openRatio(ratio: number): number {
  return Number.isFinite(ratio) ? clamp(ratio, MIN_RATIO, 1 - MIN_RATIO) : 0.5;
}

/**
 * Checks that a viewport can be laid out: every value finite, the viewport and gaps not negative,
 * and minimum sizes of at least one pixel, so every window keeps a share of its split.
 *
 * @throws {LayoutError} Naming the first field that breaks a rule, as in `metrics.minWidth`.
 */
export function checkMetrics(metrics: LayoutMetrics): void {
  const floors = [
    ['width', 0],
    ['height', 0],
    ['gap', 0],
    ['outerGap', 0],
    ['minWidth', 1],
    ['minHeight', 1],
  ] as const;

  for (const [key, floor] of floors) {
    const value = metrics[key];

    if (!Number.isFinite(value) || value < floor) {
      throw new LayoutError(`metrics.${key}`, `is ${String(value)}; it must be at least ${floor}`);
    }
  }
}

/** Tells whether a point lies inside a rect, edges included. */
export function containsPoint(rect: Rect, point: Point): boolean {
  return (
    point.x >= rect.x &&
    point.x <= rect.x + rect.width &&
    point.y >= rect.y &&
    point.y <= rect.y + rect.height
  );
}

/** The center of a rect. */
export function centerOf(rect: Rect): Point {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

/** The area of a rect. */
export function areaOf(rect: Rect): number {
  return rect.width * rect.height;
}

/** The extent of a rect along the axis a split of `orientation` divides. */
export function extentAlong(rect: Rect, orientation: Orientation): number {
  return orientation === 'row' ? rect.width : rect.height;
}

/** The smallest extent a window may take along the axis a split of `orientation` divides. */
export function minimumAlong(metrics: LayoutMetrics, orientation: Orientation): number {
  return orientation === 'row' ? metrics.minWidth : metrics.minHeight;
}

/**
 * The part of the viewport windows may use: the viewport without the outer gap. The outer gap
 * shrinks when the viewport is too small to hold it on both sides.
 *
 * @throws {LayoutError} When the metrics are invalid, as {@link checkMetrics} describes.
 */
export function usableBounds(metrics: LayoutMetrics): Rect {
  checkMetrics(metrics);
  const insetX = Math.min(metrics.outerGap, metrics.width / 2);
  const insetY = Math.min(metrics.outerGap, metrics.height / 2);
  return {
    x: insetX,
    y: insetY,
    width: metrics.width - 2 * insetX,
    height: metrics.height - 2 * insetY,
  };
}

/** Moves a rect inside bounds, shrinking it first when it is larger than they are. */
export function keepInside(rect: Rect, bounds: Rect): Rect {
  const width = Math.min(rect.width, bounds.width);
  const height = Math.min(rect.height, bounds.height);
  return {
    x: clamp(rect.x, bounds.x, bounds.x + bounds.width - width),
    y: clamp(rect.y, bounds.y, bounds.y + bounds.height - height),
    width,
    height,
  };
}
