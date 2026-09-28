import type { PointerEvent as ReactPointerEvent } from 'react';

import { ratioAtPoint, type Gutter } from '@/tiling';

import { cn } from '../lib/utils';
import { useShellStore } from '../state/shell-store';
import { startPointerDrag } from './pointer-drag';

/**
 * The gap between two tiles, which resizes their split when dragged and resets it to even on a
 * double click. It covers the gap exactly, so there are no extra handles to see.
 */
export function GutterHandle({
  gutter,
  label,
}: {
  readonly gutter: Gutter;
  readonly label: string;
}) {
  const store = useShellStore();
  const { rect, orientation } = gutter;

  const onPointerDown = (event: ReactPointerEvent) => {
    if (event.button !== 0) {
      return;
    }

    event.preventDefault();
    const { setResizing, resizeSplit } = store.getState();
    const resize = (point: { x: number; y: number }) => {
      const { origin } = store.getState();
      resizeSplit(
        gutter.path,
        ratioAtPoint(gutter, { x: point.x - origin.x, y: point.y - origin.y })
      );
    };
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
      title={label}
      data-gutter={gutter.path}
      onPointerDown={onPointerDown}
      onDoubleClick={() => store.getState().run({ type: 'resetSplit', path: gutter.path })}
      className={cn(
        'group absolute z-5 flex touch-none items-center justify-center',
        orientation === 'row' ? 'cursor-col-resize' : 'cursor-row-resize'
      )}
      style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height }}
    >
      <span
        aria-hidden
        className={cn(
          'rounded-full bg-foreground/0 transition-colors duration-150 group-hover:bg-foreground/35 group-active:bg-foreground/60',
          orientation === 'row' ? 'h-10 w-1' : 'h-1 w-10'
        )}
      />
    </div>
  );
}
