import {
  ChevronRightIcon,
  GripVerticalIcon,
  HardDriveIcon,
  LockIcon,
  MoveIcon,
  PencilIcon,
  RadioIcon,
  SearchIcon,
  XIcon,
} from 'lucide-react';
import { useEffect, useState, type PointerEvent as ReactPointerEvent } from 'react';

import { presentVariable } from '@/robot-kit';
import { activeWorkspace, focusedWindow } from '@/tiling';

import { Button } from '../components/ui/button';
import { Kbd } from '../components/ui/kbd';
import { formatHash, formatValue } from '../lib/format';
import { cn } from '../lib/utils';
import {
  useConnectionStatus,
  useLiveValue,
  useRobotPackage,
  useVariables,
  type ReactRobotPackage,
} from '../monitor-context';
import type { VariableInfo } from '../ports';
import { useShell, useShellStore } from '../state/shell-store';
import { startPointerDrag, surroundingsAt } from '../tiling/pointer-drag';
import { PLOT_KIND, windowKind } from '../windows/registry';

type Filter = 'all' | 'plotted' | 'writable';

interface Group {
  readonly name: string | null;
  readonly variables: readonly VariableInfo[];
}

function groupOf(name: string): string | null {
  const slash = name.indexOf('/');
  return slash === -1 ? null : name.slice(0, slash);
}

function groupVariables(variables: readonly VariableInfo[]): readonly Group[] {
  const groups = new Map<string, VariableInfo[]>();
  const order: Group[] = [];

  for (const variable of variables) {
    const name = groupOf(variable.name);

    if (name === null) {
      order.push({ name: null, variables: [variable] });
      continue;
    }

    const members = groups.get(name);

    if (members === undefined) {
      const created = [variable];
      groups.set(name, created);
      order.push({ name, variables: created });
    } else {
      members.push(variable);
    }
  }

  return order;
}

/**
 * The variables drawer (`/`): the schema's variables grouped by prefix, searchable, with their
 * latest values. A row dragged onto a window joins it, onto a window's edge opens a plot there;
 * Enter or a click adds the variable to the focused window, or opens a plot for it.
 */
export function VariableDrawer() {
  const store = useShellStore();
  const variables = useVariables();
  const status = useConnectionStatus();
  const selection = useRobotPackage();
  const windows = useShell((state) => state.desktop.windows);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());

  const plotted = new Set([...windows.values()].flatMap((window) => window.payload.variables));
  const needle = query.trim().toLowerCase();
  const writable = variables.filter((variable) => variable.access.write);
  const shown = variables.filter(
    (variable) =>
      (needle === '' || variable.name.toLowerCase().includes(needle)) &&
      (filter !== 'plotted' || plotted.has(variable.name)) &&
      (filter !== 'writable' || variable.access.write)
  );
  const groups = groupVariables(shown);
  const pkg = selection?.package ?? null;

  const close = () => store.getState().setOverlay(null);

  const add = (name: string) => {
    const { desktop, addVariable, openWindow } = store.getState();
    const focused = focusedWindow(activeWorkspace(desktop));
    const target = focused === null ? undefined : desktop.windows.get(focused);

    if (target !== undefined && windowKind(target.kind).acceptsVariables) {
      addVariable(target.id, name);
    } else {
      openWindow(PLOT_KIND, [name]);
    }
  };

  const toggle = (group: string) => {
    const next = new Set(collapsed);

    if (!next.delete(group)) {
      next.add(group);
    }

    setCollapsed(next);
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && store.getState().drag === null) {
        store.getState().setOverlay(null);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [store]);

  const counts: Readonly<Record<Filter, number>> = {
    all: variables.length,
    plotted: variables.filter((variable) => plotted.has(variable.name)).length,
    writable: writable.length,
  };

  return (
    <aside
      aria-label="Variables"
      data-drawer
      className="absolute top-3.5 bottom-3.5 left-3.5 z-30 flex w-[380px] flex-col overflow-hidden rounded-xl border bg-card text-card-foreground shadow-2xl animate-in fade-in-0 slide-in-from-left-4 duration-200"
    >
      <header className="flex items-start justify-between gap-2 px-5 pt-4">
        <div>
          <h2 className="text-lg font-semibold">Variables</h2>
          <p className="text-sm text-muted-foreground">
            {status.kind === 'streaming'
              ? `${variables.length} from schema ${formatHash(status.robot.schemaHash)} · ${pkg === null ? 'raw mode' : `package ${pkg.id}`}`
              : 'Connect to a robot to list its variables'}
          </p>
        </div>
        <Button variant="ghost" size="icon-sm" aria-label="Close the variables" onClick={close}>
          <XIcon />
        </Button>
      </header>
      <div className="px-4 pt-3">
        <label className="flex h-10 items-center gap-2 rounded-lg border bg-background px-3 focus-within:ring-[3px] focus-within:ring-ring/50">
          <SearchIcon className="size-4 text-muted-foreground" aria-hidden />
          <input
            // oxlint-disable-next-line jsx-a11y/no-autofocus
            autoFocus
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={`Search ${variables.length} variables`}
            aria-label="Search the variables"
            className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
          <Kbd>/</Kbd>
        </label>
        <div className="mt-3 grid grid-cols-3 rounded-lg border p-0.5">
          {(['all', 'plotted', 'writable'] as const).map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={filter === option}
              onClick={() => setFilter(option)}
              className={cn(
                'h-8 rounded-md text-sm text-muted-foreground capitalize transition-colors',
                filter === option && 'bg-accent text-foreground'
              )}
            >
              {option} <span className="ml-1 text-xs opacity-70">{counts[option]}</span>
            </button>
          ))}
        </div>
      </div>
      <ul className="mt-2 min-h-0 flex-1 overflow-y-auto px-2 pb-2" aria-label="Variable list">
        {groups.map((group) =>
          group.name === null ? (
            <VariableRow
              key={`variable:${group.variables[0].name}`}
              variable={group.variables[0]}
              label={group.variables[0].name}
              pkg={pkg}
              plotted={plotted.has(group.variables[0].name)}
              onAdd={add}
            />
          ) : (
            <li key={`group:${group.name}`}>
              <button
                type="button"
                aria-expanded={needle !== '' || !collapsed.has(group.name)}
                onClick={() => toggle(group.name ?? '')}
                className="flex h-9 w-full items-center gap-2 rounded-md px-2 text-left text-sm hover:bg-accent/50"
              >
                <ChevronRightIcon
                  aria-hidden
                  className={cn(
                    'size-4 text-muted-foreground transition-transform',
                    (needle !== '' || !collapsed.has(group.name)) && 'rotate-90'
                  )}
                />
                <span className="flex-1 font-medium">{group.name}</span>
                <span className="text-xs text-muted-foreground">{group.variables.length}</span>
              </button>
              {needle !== '' || !collapsed.has(group.name) ? (
                <ul className="pl-4">
                  {group.variables.map((variable) => (
                    <VariableRow
                      key={variable.name}
                      variable={variable}
                      label={variable.name.slice((group.name?.length ?? 0) + 1)}
                      pkg={pkg}
                      plotted={plotted.has(variable.name)}
                      onAdd={add}
                    />
                  ))}
                </ul>
              ) : null}
            </li>
          )
        )}
      </ul>
      <footer className="flex flex-col gap-2 border-t px-5 py-3 text-xs text-muted-foreground">
        <div className="flex items-center gap-4">
          <span className="flex items-center gap-1">
            <RadioIcon className="size-3.5" aria-hidden /> stream
          </span>
          <span className="flex items-center gap-1">
            <PencilIcon className="size-3.5" aria-hidden /> write
          </span>
          <span className="flex items-center gap-1">
            <HardDriveIcon className="size-3.5" aria-hidden /> persist
          </span>
          <span className="flex items-center gap-1">
            <LockIcon className="size-3.5" aria-hidden /> needs idle
          </span>
        </div>
        <p className="flex items-start gap-2">
          <MoveIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          Drag a row onto a window to plot it, or onto a window edge for a new plot.
        </p>
      </footer>
    </aside>
  );
}

interface VariableRowProps {
  readonly variable: VariableInfo;
  readonly label: string;
  readonly pkg: ReactRobotPackage | null;
  readonly plotted: boolean;
  readonly onAdd: (name: string) => void;
}

function VariableRow({ variable, label, pkg, plotted, onAdd }: VariableRowProps) {
  const store = useShellStore();
  const value = useLiveValue(variable.id);
  const dragging = useShell(
    (state) => state.drag?.subject.kind === 'variable' && state.drag.subject.name === variable.name
  );
  const { typeLabel, unit } = presentVariable(pkg, variable);
  const { access } = variable;

  const onPointerDown = (event: ReactPointerEvent) => {
    if (event.button !== 0) {
      return;
    }

    const { beginDrag, moveDrag, endDrag, cancelDrag } = store.getState();
    startPointerDrag(event, {
      onStart: (point) => beginDrag({ kind: 'variable', name: variable.name }, point),
      onMove: (point) => moveDrag(point, surroundingsAt(point)),
      onEnd: () => endDrag(),
      onCancel: () => cancelDrag(),
    });
  };

  return (
    <li>
      <button
        type="button"
        data-variable={variable.name}
        onPointerDown={onPointerDown}
        onClick={() => onAdd(variable.name)}
        title={`${variable.name}${unit === null ? '' : ` (${unit})`}`}
        className={cn(
          'group flex h-8 w-full touch-none items-center select-none gap-2 rounded-md px-2 text-left font-mono text-sm hover:bg-accent/60',
          dragging && 'bg-accent'
        )}
      >
        <GripVerticalIcon
          aria-hidden
          className="-ml-1 size-3.5 text-muted-foreground opacity-0 group-hover:opacity-100"
        />
        <span
          aria-hidden
          className={cn(
            'size-2.5 shrink-0 rounded-[3px]',
            plotted ? 'bg-chart-1' : 'border border-muted-foreground/50'
          )}
        />
        <span className="min-w-0 flex-1 truncate">{label}</span>
        <span className="w-14 truncate text-right text-xs text-muted-foreground">{typeLabel}</span>
        <span className="flex w-10 items-center gap-0.5 text-muted-foreground">
          {access.stream ? <RadioIcon className="size-3.5" aria-label="streams" /> : null}
          {access.write ? <PencilIcon className="size-3.5" aria-label="writable" /> : null}
          {access.persist ? <HardDriveIcon className="size-3.5" aria-label="persists" /> : null}
          {access.idle ? <LockIcon className="size-3.5" aria-label="needs idle" /> : null}
        </span>
        <span className="w-20 text-right tabular-nums">{formatValue(value)}</span>
      </button>
    </li>
  );
}
