/**
 * The real mouse, for browser tests: moves, presses and releases go through Playwright, so the
 * browser fires the pointer events itself, and a test can hold a drag midway to look at it.
 *
 * @module
 */

import { commands } from 'vitest/browser';

import type { Point } from '@/tiling';

import type { MouseStep } from '../../../tools/browser-mouse';

/** The middle of an element, or a point at fractions of its size, in client pixels. */
export function pointIn(element: Element, fx = 0.5, fy = 0.5): Point {
  const rect = element.getBoundingClientRect();
  return { x: rect.x + rect.width * fx, y: rect.y + rect.height * fy };
}

/** Presses the mouse at a point and moves it to another, in several steps, without releasing. */
export async function press(from: Point, to: Point): Promise<void> {
  const steps: MouseStep[] = [
    { type: 'move', ...from },
    { type: 'down' },
    { type: 'move', ...to, steps: 6 },
  ];
  await commands.mouse(steps);
}

/** Releases the mouse where it is. */
export async function release(): Promise<void> {
  await commands.mouse([{ type: 'up' }]);
}

/** Drags with the mouse from a point to another and releases it there. */
export async function drag(from: Point, to: Point): Promise<void> {
  await press(from, to);
  await release();
}
