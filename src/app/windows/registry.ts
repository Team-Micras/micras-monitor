/**
 * The window kinds of the app: for each kind, its title, icon, the component that draws it and
 * what it asks the link to stream. The components of the heavier kinds load on first use. A kind
 * from an old layout that this build does not know draws as a placeholder listing the window's
 * variables.
 *
 * @module
 */

import {
  BotIcon,
  ChartLineIcon,
  GaugeIcon,
  MapIcon,
  RadioTowerIcon,
  ScrollTextIcon,
  SlidersHorizontalIcon,
  ZapIcon,
  type LucideIcon,
} from 'lucide-react';
import { type ComponentType } from 'react';

import type { VariableDemand } from '@/core/monitor';
import { lazyWithRetry } from '@/lazy/lazy-with-retry';
import { roleVariable, type RobotPackage, type Role } from '@/robot-kit';

import { CommandsWindow } from './commands/commands-window';
import { ViewPlaceholder } from './placeholder-window';
import {
  BATTERY_RATE_HZ,
  DEFAULT_STREAM_RATE_HZ,
  EDITOR_RATE_HZ,
  PLOT_RATE_HZ,
  FOLLOW_RATE_HZ,
  READOUT_RATE_HZ,
  REVISION_RATE_HZ,
} from './rates';
import { RobotWindow } from './robot/robot-window';
import type { ShellWindow, WindowViewProps } from './types';

/** A kind of window. */
export interface WindowKind {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly icon: LucideIcon;
  readonly component: ComponentType<WindowViewProps>;
  /** Whether a variable dropped on the window joins it; otherwise the drop opens a plot beside. */
  readonly acceptsVariables: boolean;
  /**
   * What the window wants streamed, given the connected robot's package, or null in raw mode;
   * without it, each of its variables at the default rate.
   */
  readonly demand?: (window: ShellWindow, pkg: RobotPackage | null) => readonly VariableDemand[];
}

const NOTHING: readonly VariableDemand[] = [];
const nothing = () => NOTHING;

function rate(window: ShellWindow, rateHz: number): readonly VariableDemand[] {
  return window.payload.variables.map((variable) => ({ variable, rateHz }));
}

function roles(
  pkg: RobotPackage | null,
  wanted: readonly Role[],
  rateHz: number
): VariableDemand[] {
  return wanted.flatMap((role) => {
    const variable = roleVariable(pkg, role);
    return variable === null ? [] : [{ variable, rateHz }];
  });
}

function followedRoles(pkg: RobotPackage | null, blob: string): readonly Role[] {
  const tag = pkg?.variables[blob]?.serializable;
  return pkg?.types.find((type) => type.tag === tag)?.follows ?? [];
}

function typeViewDemand(window: ShellWindow, pkg: RobotPackage | null): readonly VariableDemand[] {
  const [blob] = window.payload.variables;

  if (blob === undefined) {
    return NOTHING;
  }

  const revision = blob === roleVariable(pkg, 'map') ? ['map.revision' as const] : [];
  return [
    ...roles(pkg, revision, REVISION_RATE_HZ),
    ...roles(pkg, followedRoles(pkg, blob), FOLLOW_RATE_HZ),
  ];
}

/** The kind a variable dropped on the tiling opens. */
export const PLOT_KIND = 'plot';

/** Every window kind, in the order the launcher lists them. */
export const WINDOW_KINDS: readonly WindowKind[] = [
  {
    id: PLOT_KIND,
    title: 'Plot',
    description: 'Variables over time',
    icon: ChartLineIcon,
    component: lazyWithRetry(() =>
      import('./plot/plot-window').then((module) => ({ default: module.PlotWindow }))
    ).Component,
    acceptsVariables: true,
    demand: (window) => rate(window, PLOT_RATE_HZ),
  },
  {
    id: 'readouts',
    title: 'Readouts',
    description: 'Latest values, large',
    icon: GaugeIcon,
    component: lazyWithRetry(() =>
      import('./readouts/readouts-window').then((module) => ({ default: module.ReadoutsWindow }))
    ).Component,
    acceptsVariables: true,
    demand: (window) => rate(window, READOUT_RATE_HZ),
  },
  {
    id: 'editor',
    title: 'Editor',
    description: 'Write a variable, by its type',
    icon: SlidersHorizontalIcon,
    component: lazyWithRetry(() =>
      import('./editor/editor-window').then((module) => ({ default: module.EditorWindow }))
    ).Component,
    acceptsVariables: true,
    demand: (window) => rate(window, EDITOR_RATE_HZ),
  },
  {
    id: 'type-view',
    title: 'Type view',
    description: 'A serializable value, such as the maze',
    icon: MapIcon,
    component: lazyWithRetry(() =>
      import('./type-view/type-view-window').then((module) => ({ default: module.TypeViewWindow }))
    ).Component,
    acceptsVariables: false,
    demand: typeViewDemand,
  },
  {
    id: 'robot',
    title: 'Robot',
    description: 'State, transitions and battery',
    icon: BotIcon,
    component: RobotWindow,
    acceptsVariables: false,
    demand: (_window, pkg) => [
      ...roles(pkg, ['state'], READOUT_RATE_HZ),
      ...roles(pkg, ['battery'], BATTERY_RATE_HZ),
    ],
  },
  {
    id: 'commands',
    title: 'Commands',
    description: 'The robot commands, STOP drawn big',
    icon: ZapIcon,
    component: CommandsWindow,
    acceptsVariables: false,
    demand: nothing,
  },
  {
    id: 'log',
    title: 'Log',
    description: 'Robot log and link events',
    icon: ScrollTextIcon,
    component: lazyWithRetry(() =>
      import('./log/log-window').then((module) => ({ default: module.LogWindow }))
    ).Component,
    acceptsVariables: false,
    demand: nothing,
  },
  {
    id: 'link',
    title: 'Link',
    description: 'Rate, credit, drops and round trip',
    icon: RadioTowerIcon,
    component: lazyWithRetry(() =>
      import('./link/link-window').then((module) => ({ default: module.LinkWindow }))
    ).Component,
    acceptsVariables: false,
    demand: nothing,
  },
];

const KINDS: ReadonlyMap<string, WindowKind> = new Map(WINDOW_KINDS.map((kind) => [kind.id, kind]));

/** The kind with this id; an unknown kind, as from an old layout, draws as a placeholder. */
export function windowKind(id: string): WindowKind {
  return (
    KINDS.get(id) ?? {
      id,
      title: id,
      description: 'A window kind this build does not know',
      icon: ScrollTextIcon,
      component: ViewPlaceholder,
      acceptsVariables: false,
    }
  );
}

/** The title a window shows: its own, else its kind's. */
export function windowTitle(window: ShellWindow): string {
  return window.payload.title ?? windowKind(window.kind).title;
}

/**
 * What a window asks the link to stream, as its kind says.
 *
 * @param window The window.
 * @param pkg The connected robot's package, which the kinds that read roles need; null for none.
 */
export function windowDemand(
  window: ShellWindow,
  pkg: RobotPackage | null = null
): readonly VariableDemand[] {
  const demand = windowKind(window.kind).demand;

  return demand
    ? demand(window, pkg)
    : window.payload.variables.map((variable) => ({ variable, rateHz: DEFAULT_STREAM_RATE_HZ }));
}
