/**
 * Rectangle helpers shared by layout, focus and hit testing.
 *
 * @module
 */

import type { LayoutMetrics, Orientation, Point, Rect } from './types';

/** Restricts a value to a range. */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
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

/** The centre of a rect. */
export function centreOf(rect: Rect): Point {
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
 */
export function usableBounds(metrics: LayoutMetrics): Rect {
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
