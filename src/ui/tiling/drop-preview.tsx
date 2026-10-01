import { MoveIcon } from 'lucide-react';

import type { Side } from '@/tiling';

import { useShell } from '../state/shell-store';
import { windowTitle } from '../windows/registry';

const SIDE_WORDS: Readonly<Record<Side, string>> = {
  left: 'left of',
  right: 'right of',
  top: 'above',
  bottom: 'below',
};

/** Shows where the window or variable being dragged would land, with words for it. */
export function DropPreview() {
  const drag = useShell((state) => state.drag);
  const windows = useShell((state) => state.desktop.windows);
  const target = drag?.target;

  if (drag === null || target === null || target === undefined || target.kind === 'workspace') {
    return null;
  }

  const other = target.kind === 'new' ? null : windows.get(target.id);
  const name = other === undefined || other === null ? '' : windowTitle(other);
  const variable = drag.subject.kind === 'variable';
  const label =
    target.kind === 'new'
      ? 'Open a new plot'
      : target.kind === 'center'
        ? variable
          ? `Add to ${name}`
          : `Swap with ${name}`
        : `${variable ? 'New plot' : 'Place'} ${SIDE_WORDS[target.side]} ${name}`;
  const { preview } = target;

  return (
    <div
      data-drop-preview={target.kind}
      className="pointer-events-none absolute z-40 flex items-center justify-center rounded-xl border border-foreground/30 bg-foreground/8 transition-[left,top,width,height] duration-150 ease-out motion-reduce:transition-none"
      style={{ left: preview.x, top: preview.y, width: preview.width, height: preview.height }}
    >
      <span className="flex items-center gap-2 rounded-lg border bg-popover px-3 py-1.5 text-sm text-popover-foreground shadow-md">
        <MoveIcon className="size-4 text-muted-foreground" aria-hidden />
        {label}
      </span>
    </div>
  );
}
