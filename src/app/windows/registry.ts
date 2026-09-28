/**
 * The window kinds of the app: for each kind, its title, icon and the component that draws it.
 * The generic windows arrive in slice 5; until then every kind draws a placeholder that lists
 * the window's variables with their latest values, and the kinds that take variables say so.
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
import type { ComponentType } from 'react';

import { DEFAULT_STREAM_RATE_HZ, type StreamDemand } from '../ports/streams';

import { PlaceholderWindow, ViewPlaceholder } from './placeholder-window';
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
  /** What the window wants streamed; without it, each of its variables at the default rate. */
  readonly demand?: (window: ShellWindow) => readonly StreamDemand[];
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
    component: PlaceholderWindow,
    acceptsVariables: true,
  },
  {
    id: 'readouts',
    title: 'Readouts',
    description: 'Latest values, large',
    icon: GaugeIcon,
    component: PlaceholderWindow,
    acceptsVariables: true,
  },
  {
    id: 'editor',
    title: 'Editor',
    description: 'Write a variable, by its type',
    icon: SlidersHorizontalIcon,
    component: PlaceholderWindow,
    acceptsVariables: true,
  },
  {
    id: 'type-view',
    title: 'Type view',
    description: 'A serializable value, such as the maze',
    icon: MapIcon,
    component: ViewPlaceholder,
    acceptsVariables: false,
  },
  {
    id: 'robot',
    title: 'Robot',
    description: 'State, transitions and battery',
    icon: BotIcon,
    component: ViewPlaceholder,
    acceptsVariables: false,
  },
  {
    id: 'commands',
    title: 'Commands',
    description: 'The robot commands, STOP drawn big',
    icon: ZapIcon,
    component: ViewPlaceholder,
    acceptsVariables: false,
  },
  {
    id: 'log',
    title: 'Log',
    description: 'Robot log and link events',
    icon: ScrollTextIcon,
    component: ViewPlaceholder,
    acceptsVariables: false,
  },
  {
    id: 'link',
    title: 'Link',
    description: 'Rate, credit, drops and round trip',
    icon: RadioTowerIcon,
    component: ViewPlaceholder,
    acceptsVariables: false,
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

/** What a window asks the link to stream, as its kind says. */
export function windowDemand(window: ShellWindow): readonly StreamDemand[] {
  const demand = windowKind(window.kind).demand;

  return demand
    ? demand(window)
    : window.payload.variables.map((variable) => ({ variable, rateHz: DEFAULT_STREAM_RATE_HZ }));
}
