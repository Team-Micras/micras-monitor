import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';

import { Separator } from 'radix-ui';

import { ratioAtPoint, type Gutter } from '@/tiling';

import { cn } from '../lib/utils';
import { useShellStore } from '../state/shell-store';
import { windowElementId } from './dom-ids';
import { startPointerDrag } from './pointer-drag';

const KEY_STEP = 0.02;
const KEY_STEP_LARGE = 0.1;

/**
 * The gap between two tiles, which resizes their split when dragged and resets it to even on a
 * double click. It covers the gap exactly, so there are no extra handles to see. It is also a
 * focusable window splitter, after the WAI-ARIA pattern: the arrows along its axis move it by 2%
 * (10% with Shift), Home and End take it to the smallest and largest share of the first side, and
 * Enter evens the split out (a tile here has a minimum size, so nothing collapses). Its value is
 * the first side's share, and `aria-controls` names the first window of that side. It is named
 * after the first windows of both sides, since either can hold several. It is a Radix separator
 * because oxlint rejects the role on a plain element.
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
  const min = Math.ceil(gutter.minRatio * 100);
  const max = Math.max(min, Math.floor(gutter.maxRatio * 100));
  const now = Math.min(max, Math.max(min, Math.round(gutter.ratio * 100)));

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

  const onKeyDown = (event: ReactKeyboardEvent) => {
    const { resizeSplit, run } = store.getState();
    const along = orientation === 'row' ? ['ArrowLeft', 'ArrowRight'] : ['ArrowUp', 'ArrowDown'];
    const step = event.shiftKey ? KEY_STEP_LARGE : KEY_STEP;
    const target = {
      [along[0]]: gutter.ratio - step,
      [along[1]]: gutter.ratio + step,
      Home: gutter.minRatio,
      End: gutter.maxRatio,
    }[event.key];

    if (event.altKey || event.ctrlKey || event.metaKey) {
      return;
    }

    if (event.key === 'Enter') {
      event.preventDefault();
      run({ type: 'resetSplit', path: gutter.path });
    } else if (target !== undefined) {
      event.preventDefault();
      resizeSplit(gutter.path, target);
    }
  };

  return (
    <Separator.Root
      decorative={false}
      orientation={orientation === 'row' ? 'vertical' : 'horizontal'}
      tabIndex={0}
      aria-controls={windowElementId(gutter.between[0])}
      aria-label={label}
      aria-orientation={orientation === 'row' ? 'vertical' : 'horizontal'}
      aria-valuenow={now}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuetext={`${now}% for the first window`}
      title={label}
      data-gutter={gutter.path}
      onKeyDown={onKeyDown}
      onPointerDown={onPointerDown}
      onDoubleClick={() => store.getState().run({ type: 'resetSplit', path: gutter.path })}
      className={cn(
        'group absolute z-5 flex touch-none items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring',
        orientation === 'row' ? 'cursor-col-resize' : 'cursor-row-resize'
      )}
      style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height }}
    >
      <span
        aria-hidden
        className={cn(
          'rounded-full bg-foreground/0 transition-colors duration-150 group-hover:bg-foreground/35 group-focus-visible:bg-foreground/60 group-active:bg-foreground/60',
          orientation === 'row' ? 'h-10 w-1' : 'h-1 w-10'
        )}
      />
    </Separator.Root>
  );
}
