import {
  EllipsisIcon,
  MaximizeIcon,
  PauseIcon,
  PictureInPicture2Icon,
  PlayIcon,
  XIcon,
} from 'lucide-react';
import { Suspense, type PointerEvent as ReactPointerEvent } from 'react';

import type { DesktopWindow, Rect } from '@/tiling';

import { Button } from '../components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '../components/ui/dropdown-menu';
import { formatChord } from '../keymap/chords';
import type { KeyAction } from '../keymap/keymap';
import { cn } from '../lib/utils';
import { formatValue } from '../lib/format';
import { useConnectionStatus, useLinkUp, useLiveValue } from '../monitor-context';
import { useShell, useShellStore } from '../state/shell-store';
import { windowKind, windowTitle } from '../windows/registry';
import type { ShellWindow } from '../windows/types';
import { startPointerDrag, surroundingsAt } from './pointer-drag';
import { WindowErrorBoundary } from './window-error-boundary';

/** How a window sits in the tiling. */
export interface WindowFrameProps {
  readonly window: ShellWindow;
  readonly placed: DesktopWindow;
  readonly focused: boolean;
  readonly maximized: boolean;
  /** Its place in the floating stack, for floating windows. */
  readonly stackIndex: number;
}

const SERIES_COLORS = ['bg-chart-1', 'bg-chart-2', 'bg-chart-3', 'bg-chart-4', 'bg-chart-5'];

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
  const workspaces = useShell((state) => state.desktop.workspaces);
  const bindings = useShell((state) => state.bindings);
  const status = useConnectionStatus();
  const live = status.kind === 'linked' && status.phase !== 'schema';
  const kind = windowKind(window.kind);
  const View = kind.component;
  const Icon = kind.icon;
  const title = windowTitle(window);
  const { rect, floating, visible } = placed;

  const shortcut = (action: KeyAction) => {
    const chord = bindings.get(action)?.[0];
    return chord === undefined ? null : (
      <DropdownMenuShortcut>{formatChord(chord).join('+')}</DropdownMenuShortcut>
    );
  };

  const focus = () => {
    if (!focused) {
      store.getState().run({ type: 'focusWindow', id: window.id });
    }
  };

  const onTitlePointerDown = (event: ReactPointerEvent) => {
    if (
      event.button !== 0 ||
      (event.target instanceof Element && event.target.closest('button') !== null)
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
      aria-label={title}
      aria-hidden={!visible}
      inert={!visible}
      data-window={window.id}
      data-focused={focused}
      tabIndex={-1}
      onPointerDownCapture={focus}
      className={cn(
        'absolute flex flex-col overflow-hidden rounded-xl border bg-card text-card-foreground outline-none',
        animate && 'transition-[left,top,width,height,opacity] duration-200 ease-out',
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
        <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
          {window.payload.variables.slice(0, 3).map((name, index) => (
            <SeriesChip
              key={name}
              name={name}
              color={SERIES_COLORS[index % SERIES_COLORS.length]}
            />
          ))}
        </div>
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
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label={`${title} menu`}>
              <EllipsisIcon />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuItem
              disabled={floating}
              onSelect={() => store.getState().run({ type: 'toggleMaximize' })}
            >
              <MaximizeIcon />
              {maximized ? 'Restore' : 'Maximize'}
              {shortcut('window.maximize')}
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => store.getState().run({ type: 'toggleFloating', id: window.id })}
            >
              <PictureInPicture2Icon />
              {floating ? 'Tile' : 'Float'}
              {shortcut('window.float')}
            </DropdownMenuItem>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>Move to workspace</DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                {workspaces.map((workspace, index) =>
                  index === placed.workspace ? null : (
                    <DropdownMenuItem
                      key={workspace.name}
                      onSelect={() =>
                        store
                          .getState()
                          .run({ type: 'moveToWorkspace', index, id: window.id, follow: false })
                      }
                    >
                      {workspace.name}
                    </DropdownMenuItem>
                  )
                )}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              onSelect={() => store.getState().run({ type: 'close', id: window.id })}
            >
              <XIcon />
              Close
              {shortcut('window.close')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </header>
      <div className="min-h-0 flex-1">
        <WindowErrorBoundary>
          <Suspense fallback={null}>
            <View window={window} paused={paused} visible={visible} />
          </Suspense>
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

function SeriesChip({ name, color }: { readonly name: string; readonly color: string }) {
  const value = useLiveValue(name)?.value;
  const linked = useLinkUp();

  return (
    <span
      data-series={name}
      data-value={typeof value === 'number' ? value : undefined}
      className="flex shrink-0 items-center gap-1.5 rounded-md bg-muted px-2 py-0.5 font-mono text-xs"
    >
      <span className={cn('size-2 shrink-0 rounded-[2px]', color)} aria-hidden />
      <span className="text-muted-foreground">{name}</span>
      <span className={cn('tabular-nums', !linked && 'text-muted-foreground')}>
        {formatValue(value)}
      </span>
    </span>
  );
}
