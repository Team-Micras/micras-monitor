import type { PointerEvent as ReactPointerEvent } from 'react';

import { cornerCrossing, type CornerHandle as Handle } from '@/tiling';

import { cn } from '../lib/utils';
import { useShellStore } from '../state/shell-store';
import { startPointerDrag } from './pointer-drag';

/** How far a corner handle reaches into its window, in pixels. */
export const CORNER_INSET = 10;

/**
 * The corner of a tiled window where a vertical and a horizontal gap meet. Dragging it moves both
 * splits at once, with the same minimum sizes and live preview as dragging either gap; the point
 * grabbed stays under the pointer. It is left out of the Tab order and hidden from assistive
 * technology, since each of its gaps is a keyboard splitter of its own.
 */
export function CornerHandle({ handle }: { readonly handle: Handle }) {
  const store = useShellStore();
  const { rect, corner } = handle;

  const onPointerDown = (event: ReactPointerEvent) => {
    const { desktop, metrics, origin } = store.getState();
    const crossing = cornerCrossing(desktop, handle, metrics);

    if (event.button !== 0 || crossing === null) {
      return;
    }

    event.preventDefault();
    const offset = {
      x: event.clientX - origin.x - crossing.x,
      y: event.clientY - origin.y - crossing.y,
    };
    const resize = (point: { x: number; y: number }) => {
      const { origin: at, resizeCorner } = store.getState();
      resizeCorner(handle, { x: point.x - at.x - offset.x, y: point.y - at.y - offset.y });
    };
    const { setResizing } = store.getState();
    setResizing(true);
    startPointerDrag(
      event,
      {
        onMove: resize,
        onEnd: (point) => {
          resize(point);
          setResizing(false);
        },
        onCancel: () => setResizing(false),
      },
      0
    );
  };

  return (
    <div
      aria-hidden
      data-corner={`${handle.id} ${corner}`}
      onPointerDown={onPointerDown}
      className={cn(
        'absolute z-6 touch-none',
        corner === 'top-left' || corner === 'bottom-right'
          ? 'cursor-nwse-resize'
          : 'cursor-nesw-resize'
      )}
      style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height }}
    />
  );
}
