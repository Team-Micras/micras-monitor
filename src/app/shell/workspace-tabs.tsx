import { ArrowLeftIcon, ArrowRightIcon, PlusIcon, Trash2Icon } from 'lucide-react';
import {
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';

import { neighborWorkspace } from '@/tiling';

import { Button } from '../components/ui/button';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from '../components/ui/context-menu';
import { formatChord } from '../keymap/chords';
import { workspaceAction, type KeyAction } from '../keymap/keymap';
import { cn } from '../lib/utils';
import { useShell, useShellStore } from '../state/shell-store';
import { startPointerDrag } from '../tiling/pointer-drag';
import { movedTo, slotAt } from './tab-reorder';

/**
 * A tab being dragged to another place: where it was, the gap it would drop in, and where that
 * gap is across the tab list, in pixels.
 */
interface Reorder {
  readonly from: number;
  readonly slot: number;
  readonly left: number;
}

function tabsIn(list: HTMLElement | null): HTMLElement[] {
  return list === null ? [] : [...list.querySelectorAll<HTMLElement>('[data-workspace-tab]')];
}

function middles(list: HTMLElement | null): number[] {
  return tabsIn(list).map((tab) => {
    const { left, width } = tab.getBoundingClientRect();
    return left + width / 2;
  });
}

function indicatorLeft(list: HTMLElement | null, slot: number): number {
  const tabs = tabsIn(list);
  const origin = list?.getBoundingClientRect().left ?? 0;
  const before = tabs[slot - 1]?.getBoundingClientRect();
  const after = tabs[slot]?.getBoundingClientRect();

  if (before !== undefined && after !== undefined) {
    return (before.right + after.left) / 2 - origin;
  }

  return (before?.right ?? after?.left ?? origin) - origin;
}

function reorderAt(list: HTMLElement | null, from: number, x: number): Reorder {
  const slot = slotAt(middles(list), x);
  return { from, slot, left: indicatorLeft(list, slot) };
}

/**
 * The workspace tabs: click one to show it, drop a window on one to move the window there, drag
 * one along the bar to reorder the workspaces, and add workspaces with the plus button. A tab's
 * context menu moves or closes its workspace, with or without its windows.
 */
export function WorkspaceTabs() {
  const store = useShellStore();
  const workspaces = useShell((state) => state.desktop.workspaces);
  const bindings = useShell((state) => state.bindings);
  const active = useShell((state) => state.desktop.active);
  const dropIndex = useShell((state) =>
    state.drag?.target?.kind === 'workspace' ? state.drag.target.index : null
  );
  const [reorder, setReorder] = useState<Reorder | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const dragged = useRef(false);

  const chordOf = (action: KeyAction | null) => {
    const chord = action === null ? undefined : bindings.get(action)?.[0];
    return chord === undefined ? undefined : formatChord(chord).join('+');
  };
  const shortcut = (action: KeyAction) => {
    const chord = chordOf(action);
    return chord === undefined ? null : <ContextMenuShortcut>{chord}</ContextMenuShortcut>;
  };

  const onTabPointerDown = (index: number) => (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (
      event.button !== 0 ||
      !(event.target instanceof Node) ||
      !event.currentTarget.contains(event.target)
    ) {
      return;
    }

    dragged.current = false;
    startPointerDrag(event, {
      onStart: (point) => {
        dragged.current = true;
        setReorder(reorderAt(list.current, index, point.x));
      },
      onMove: (point) => setReorder(reorderAt(list.current, index, point.x)),
      onEnd: (point) => {
        setReorder(null);
        const to = movedTo(index, reorderAt(list.current, index, point.x).slot);

        if (to !== null) {
          store.getState().run({ type: 'moveWorkspace', from: index, to });
        }
      },
      onCancel: () => {
        dragged.current = false;
        setReorder(null);
      },
    });
  };

  const onTabClick = (index: number, event: ReactMouseEvent) => {
    const afterDrag = dragged.current && event.detail > 0;
    dragged.current = false;

    if (afterDrag) {
      return;
    }

    store.getState().run({ type: 'switchWorkspace', index });
  };

  const moves = reorder !== null && movedTo(reorder.from, reorder.slot) !== null;

  return (
    <nav
      aria-label="Workspaces"
      className="flex items-center gap-0.5 rounded-xl border bg-muted/50 p-1"
    >
      <div ref={list} role="tablist" className="relative flex items-center gap-0.5">
        {workspaces.map((workspace, index) => {
          const empty = workspace.root === null && workspace.floating.length === 0;
          const alone = workspaces.length === 1;
          const neighbor = neighborWorkspace(index);
          const destinations = workspaces
            .map((other, at) => ({ name: other.name, at }))
            .filter(({ at }) => at !== index)
            .toSorted((a, b) => Number(b.at === neighbor) - Number(a.at === neighbor));
          return (
            <ContextMenu key={workspace.name}>
              <ContextMenuTrigger asChild>
                <button
                  type="button"
                  role="tab"
                  aria-selected={index === active}
                  data-workspace-tab={index}
                  data-reordering={reorder?.from === index || undefined}
                  title={chordOf(workspaceAction(index))}
                  onPointerDown={onTabPointerDown(index)}
                  onClick={(event) => onTabClick(index, event)}
                  className={cn(
                    'h-8 touch-none rounded-lg px-3.5 text-sm text-muted-foreground transition-[color,background-color,opacity] select-none hover:text-foreground',
                    index === active &&
                      'bg-background text-foreground shadow-sm ring-1 ring-border',
                    dropIndex === index &&
                      'bg-foreground/10 text-foreground ring-2 ring-foreground/40',
                    reorder?.from === index && 'cursor-grabbing opacity-50'
                  )}
                >
                  {workspace.name}
                </button>
              </ContextMenuTrigger>
              <ContextMenuContent className="w-72">
                <ContextMenuItem
                  disabled={index === 0}
                  onSelect={() =>
                    store.getState().run({ type: 'moveWorkspace', from: index, to: index - 1 })
                  }
                >
                  <ArrowLeftIcon />
                  Move left
                  {index === active ? shortcut('workspace.move-left') : null}
                </ContextMenuItem>
                <ContextMenuItem
                  disabled={index === workspaces.length - 1}
                  onSelect={() =>
                    store.getState().run({ type: 'moveWorkspace', from: index, to: index + 1 })
                  }
                >
                  <ArrowRightIcon />
                  Move right
                  {index === active ? shortcut('workspace.move-right') : null}
                </ContextMenuItem>
                <ContextMenuSeparator />
                {empty ? null : (
                  <ContextMenuSub>
                    <ContextMenuSubTrigger disabled={alone}>
                      Close workspace, move its windows to
                    </ContextMenuSubTrigger>
                    <ContextMenuSubContent>
                      {destinations.map(({ name, at }) => (
                        <ContextMenuItem
                          key={name}
                          onSelect={() =>
                            store.getState().run({
                              type: 'removeWorkspace',
                              index,
                              policy: { mergeInto: at },
                            })
                          }
                        >
                          {name}
                        </ContextMenuItem>
                      ))}
                    </ContextMenuSubContent>
                  </ContextMenuSub>
                )}
                <ContextMenuItem
                  variant="destructive"
                  disabled={alone}
                  onSelect={() => store.getState().requestCloseWorkspace(index, 'close')}
                >
                  <Trash2Icon />
                  {empty ? 'Close workspace' : 'Close workspace and its windows…'}
                  {index === active ? shortcut('workspace.close') : null}
                </ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>
          );
        })}
        {moves ? (
          <span
            aria-hidden
            data-tab-drop-indicator={reorder.slot}
            className="pointer-events-none absolute top-1/2 h-6 w-0.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-foreground shadow-[0_0_0_3px_var(--color-background)]"
            style={{ left: reorder.left }}
          />
        ) : null}
      </div>
      <Button
        variant="ghost"
        size="icon-sm"
        className="rounded-lg text-muted-foreground"
        aria-label="Add a workspace"
        onClick={() => store.getState().addWorkspace()}
      >
        <PlusIcon />
      </Button>
    </nav>
  );
}
