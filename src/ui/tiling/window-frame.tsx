import { PauseIcon, PlayIcon } from 'lucide-react';
import type { PointerEvent as ReactPointerEvent } from 'react';

import type { DesktopWindow, Rect } from '@/tiling';

import { useShownMonitor } from '../monitor-context';
import { Button } from '../primitives/button';
import { cn } from '../primitives/utils';
import { useShell, useShellStore } from '../state/shell-store';
import { windowKind, windowTitle } from '../windows/registry';
import { useLinkLive } from '../windows/shared/session-end';
import type { ShellWindow } from '../windows/types';
import { windowElementId } from './keyboard-order';
import { startPointerDrag, surroundingsAt } from './pointer-drag';
import { SeriesChips } from './series-chips';
import { WindowErrorBoundary } from './window-error-boundary';
import { WindowMenu } from './window-menu';

/** How a window sits in the tiling. */
export interface WindowFrameProps {
  readonly window: ShellWindow;
  readonly placed: DesktopWindow;
  readonly focused: boolean;
  readonly maximized: boolean;
  /** Its place in the floating stack, for floating windows. */
  readonly stackIndex: number;
}

/**
 * A window of the tiling: frame, title bar and the view of its kind. It is positioned
 * absolutely from its computed rect, so moving it between tiles or workspaces never remounts
 * its view.
 */
export function WindowFrame({ window, placed, focused, maximized, stackIndex }: WindowFrameProps) {
  const store = useShellStore();
  const paused = useShell((state) => state.paused.has(window.id));
  const dragged = useShell(
    (state) => state.drag?.subject.kind === 'window' && state.drag.subject.id === window.id
  );
  const animate = useShell((state) => !state.resizing && state.drag === null);
  const live = useLinkLive(useShownMonitor());
  const kind = windowKind(window.kind);
  const View = kind.component;
  const Icon = kind.icon;
  const title = windowTitle(window);
  const { rect, floating, visible } = placed;
  const { variables } = window.payload;

  const focus = () => {
    if (!focused) {
      store.getState().run({ type: 'focusWindow', id: window.id });
    }
  };

  const onTitlePointerDown = (event: ReactPointerEvent) => {
    if (
      event.button !== 0 ||
      !(event.target instanceof Element) ||
      !event.currentTarget.contains(event.target) ||
      event.target.closest('button') !== null
    ) {
      return;
    }

    event.preventDefault();
    focus();
    const { beginDrag, moveDrag, endDrag, cancelDrag } = store.getState();
    startPointerDrag(event, {
      onStart: (point) => beginDrag({ kind: 'window', id: window.id }, point),
      onMove: (point) => moveDrag(point, surroundingsAt(point)),
      onEnd: () => endDrag(),
      onCancel: () => cancelDrag(),
    });
  };

  const onResizePointerDown = (event: ReactPointerEvent) => {
    event.preventDefault();
    event.stopPropagation();
    const start: Rect = rect;
    const origin = { x: event.clientX, y: event.clientY };
    const place = (point: { x: number; y: number }) =>
      store.getState().placeFloating(window.id, {
        ...start,
        width: start.width + point.x - origin.x,
        height: start.height + point.y - origin.y,
      });
    store.getState().setResizing(true);
    startPointerDrag(
      event,
      {
        onMove: place,
        onEnd: (point) => {
          place(point);
          store.getState().setResizing(false);
        },
        onCancel: () => store.getState().setResizing(false),
      },
      0
    );
  };

  return (
    <section
      id={windowElementId(window.id)}
      aria-label={title}
      aria-hidden={!visible}
      inert={!visible}
      data-window={window.id}
      data-focused={focused}
      tabIndex={-1}
      onPointerDownCapture={focus}
      className={cn(
        'absolute flex flex-col overflow-hidden rounded-xl border bg-card text-card-foreground outline-none',
        animate &&
          'transition-[left,top,width,height,opacity] duration-200 ease-out motion-reduce:transition-none',
        focused ? 'border-foreground/25 shadow-sm' : 'border-border',
        floating && 'shadow-2xl',
        dragged && 'opacity-40',
        !visible && 'invisible'
      )}
      style={{
        left: rect.x,
        top: rect.y,
        width: rect.width,
        height: rect.height,
        zIndex: floating ? 20 + stackIndex : maximized ? 10 : undefined,
      }}
    >
      <header
        onPointerDown={onTitlePointerDown}
        className="flex h-11 shrink-0 cursor-grab touch-none items-center gap-2 pr-2 pl-3.5 select-none active:cursor-grabbing"
      >
        <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <h2 className="shrink-0 text-sm font-medium">{title}</h2>
        <SeriesChips window={window.id} title={title} variables={variables} />
        {paused ? (
          <span className="rounded-md border px-2 py-0.5 text-xs text-muted-foreground">
            Paused
          </span>
        ) : live ? (
          <span className="flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs">
            <span className="size-1.5 rounded-full bg-emerald-500" aria-hidden />
            Live
          </span>
        ) : null}
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={paused ? `Resume ${title}` : `Pause ${title}`}
          onClick={() => store.getState().togglePause(window.id)}
        >
          {paused ? <PlayIcon /> : <PauseIcon />}
        </Button>
        <WindowMenu
          window={window}
          title={title}
          workspaceIndex={placed.workspace}
          floating={floating}
          maximized={maximized}
        />
      </header>
      <div className="min-h-0 flex-1">
        <WindowErrorBoundary title={title}>
          <View window={window} paused={paused} visible={visible} />
        </WindowErrorBoundary>
      </div>
      {floating ? (
        <div
          aria-hidden
          data-resize-handle
          onPointerDown={onResizePointerDown}
          className="absolute right-0 bottom-0 size-4 cursor-nwse-resize touch-none"
        />
      ) : null}
    </section>
  );
}
