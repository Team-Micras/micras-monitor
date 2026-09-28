/**
 * Pointer drags for the tiling: the gesture itself, and what is under the pointer while it
 * lasts.
 *
 * @module
 */

import type { Point } from '@/tiling';

import type { DragSurroundings } from '../state/shell-store';

/** What a drag does as it goes. */
export interface PointerDragHandlers {
  /** The pointer moved past the threshold; called once, before the first `onMove`. */
  readonly onStart?: (point: Point) => void;
  readonly onMove: (point: Point) => void;
  readonly onEnd: (point: Point) => void;
  /** The drag was abandoned with Escape or by the browser. */
  readonly onCancel?: () => void;
}

/**
 * Follows a pointer from a pointerdown until it is released. The listeners sit on the window,
 * so the drag goes on over any element; nothing happens until the pointer has moved
 * `threshold` pixels, which leaves plain clicks alone.
 */
export function startPointerDrag(
  down: { readonly clientX: number; readonly clientY: number },
  handlers: PointerDragHandlers,
  threshold = 4
): void {
  const origin = { x: down.clientX, y: down.clientY };
  let started = threshold <= 0;

  if (started) {
    handlers.onStart?.(origin);
  }

  const stop = () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onCancel);
    window.removeEventListener('keydown', onKey, { capture: true });
  };

  const onMove = (event: PointerEvent) => {
    const point = { x: event.clientX, y: event.clientY };

    if (!started) {
      if (Math.hypot(point.x - origin.x, point.y - origin.y) < threshold) {
        return;
      }

      started = true;
      handlers.onStart?.(origin);
    }

    event.preventDefault();
    handlers.onMove(point);
  };

  const onUp = (event: PointerEvent) => {
    stop();

    if (started) {
      handlers.onEnd({ x: event.clientX, y: event.clientY });
    }
  };

  const onCancel = () => {
    stop();

    if (started) {
      handlers.onCancel?.();
    }
  };

  const onKey = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onCancel();
    }
  };

  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onCancel);
  window.addEventListener('keydown', onKey, { capture: true });
}

/** What lies under a point during a drag: a workspace tab, the tiling, or neither. */
export function surroundingsAt(point: Point): DragSurroundings {
  const element = document.elementFromPoint(point.x, point.y);
  const tab = element?.closest('[data-workspace-tab]')?.getAttribute('data-workspace-tab');
  return {
    tab: tab === undefined || tab === null ? null : Number(tab),
    overTiling: element?.closest('[data-tiling]') !== null && element !== null,
  };
}
