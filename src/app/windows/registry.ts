/**
 * The window kinds of the app: for each kind, its title, icon, the component that draws it and
 * what it asks the link to stream. A kind from an old layout that this build does not know
 * draws as a placeholder listing the window's variables.
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

import { CommandsWindow } from './commands/commands-window';
import { EditorWindow } from './editor/editor-window';
import { LinkWindow } from './link/link-window';
import { LogWindow } from './log/log-window';
import { ViewPlaceholder } from './placeholder-window';
import { PlotWindow } from './plot/plot-window';
import { ReadoutsWindow } from './readouts/readouts-window';
import { RobotWindow } from './robot/robot-window';
import { TypeViewWindow } from './type-view/type-view-window';
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

/** Samples per second a plot asks for: a control loop's signals, drawn smoothly. */
export const PLOT_RATE_HZ = 100;

/** Samples per second a readout or the Robot window asks for: numbers change ten times a second. */
export const READOUT_RATE_HZ = 10;

/** Samples per second an editor asks for, to see the confirmed value soon after a write. */
export const EDITOR_RATE_HZ = 5;

const NOTHING: readonly StreamDemand[] = [];
const nothing = () => NOTHING;

function rate(window: ShellWindow, rateHz: number): readonly StreamDemand[] {
  return window.payload.variables.map((variable) => ({ variable, rateHz }));
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
    component: PlotWindow,
    acceptsVariables: true,
    demand: (window) => rate(window, PLOT_RATE_HZ),
  },
  {
    id: 'readouts',
    title: 'Readouts',
    description: 'Latest values, large',
    icon: GaugeIcon,
    component: ReadoutsWindow,
    acceptsVariables: true,
    demand: (window) => rate(window, READOUT_RATE_HZ),
  },
  {
    id: 'editor',
    title: 'Editor',
    description: 'Write a variable, by its type',
    icon: SlidersHorizontalIcon,
    component: EditorWindow,
    acceptsVariables: true,
    demand: (window) => rate(window, EDITOR_RATE_HZ),
  },
  {
    id: 'type-view',
    title: 'Type view',
    description: 'A serializable value, such as the maze',
    icon: MapIcon,
    component: TypeViewWindow,
    acceptsVariables: false,
    demand: nothing,
  },
  {
    id: 'robot',
    title: 'Robot',
    description: 'State, transitions and battery',
    icon: BotIcon,
    component: RobotWindow,
    acceptsVariables: false,
    demand: (window) => rate(window, READOUT_RATE_HZ),
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
    component: LogWindow,
    acceptsVariables: false,
    demand: nothing,
  },
  {
    id: 'link',
    title: 'Link',
    description: 'Rate, credit, drops and round trip',
    icon: RadioTowerIcon,
    component: LinkWindow,
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

/** What a window asks the link to stream, as its kind says. */
export function windowDemand(window: ShellWindow): readonly StreamDemand[] {
  const demand = windowKind(window.kind).demand;

  return demand
    ? demand(window)
    : window.payload.variables.map((variable) => ({ variable, rateHz: DEFAULT_STREAM_RATE_HZ }));
}
