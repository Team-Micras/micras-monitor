/**
 * What the phone shows, chosen from the connected robot's package and schema by role and by
 * kind, so that any robot gets a sensible view: the map when the package names one, two values
 * and a small plot from the plots its presets open, its commands, and the settings it labels and
 * lets the user write.
 *
 * @module
 */

import { roleVariable, type LayoutPreset, type PresetNode, type RobotPackage } from '@/core/robot';
import type { Variable } from '@/core/variables';

import type { ShellWindow } from '../windows/types';

/** How many values the phone shows next to each other. */
export const PHONE_VALUE_COUNT = 2;

/** How many settings the phone lets the user write. */
export const PHONE_SETTING_COUNT = 2;

/** The windows of the phone view; a part the robot has nothing for is null. */
export interface PhonePlan {
  readonly maze: ShellWindow | null;
  readonly values: ShellWindow | null;
  readonly commands: ShellWindow;
  readonly plot: ShellWindow | null;
  readonly settings: ShellWindow | null;
}

function windowsOf(node: PresetNode | null): readonly { kind: string; variables: string[] }[] {
  if (node === null) {
    return [];
  }

  if ('window' in node) {
    return [{ kind: node.window.kind, variables: [...(node.window.variables ?? [])] }];
  }

  return [...windowsOf(node.first), ...windowsOf(node.second)];
}

function plotsOf(presets: readonly LayoutPreset[]): readonly (readonly string[])[] {
  return presets
    .flatMap((preset) => windowsOf(preset.root))
    .filter((entry) => entry.kind === 'plot' && entry.variables.length > 0)
    .map((entry) => entry.variables);
}

function isNumeric(variable: Variable): boolean {
  return variable.type !== 'bytes' && variable.type !== 'bool';
}

function win(id: string, kind: string, variables: readonly string[], title?: string): ShellWindow {
  return { id, kind, payload: title === undefined ? { variables } : { title, variables } };
}

/**
 * The phone view of a robot.
 *
 * @param pkg The robot's package, or null for raw mode.
 * @param variables The variables of its schema; empty until it loads.
 */
export function phonePlan(pkg: RobotPackage | null, variables: readonly Variable[]): PhonePlan {
  const known = new Set(variables.map((variable) => variable.name));
  const exists = (name: string) => known.size === 0 || known.has(name);
  const map = roleVariable(pkg, 'map');
  const reserved = new Set(Object.values(pkg?.roles ?? {}));

  const plots = plotsOf(pkg?.presets ?? []).map((names) => names.filter(exists));
  const fromSchema = variables
    .filter((variable) => variable.access.stream && isNumeric(variable))
    .filter((variable) => !reserved.has(variable.name))
    .map((variable) => variable.name);
  const candidates = [
    ...new Set([...plots.flatMap((names) => names.slice(0, 1)), ...plots.flat(), ...fromSchema]),
  ];
  const plotted = plots.find((names) => names.length > 0) ?? fromSchema.slice(0, 2);
  const shown = candidates.slice(0, PHONE_VALUE_COUNT);
  const settings = variables
    .filter((variable) => variable.access.write)
    .filter((variable) => pkg?.variables[variable.name]?.labels !== undefined)
    .filter((variable) => variable.name !== roleVariable(pkg, 'state'))
    .map((variable) => variable.name)
    .slice(0, PHONE_SETTING_COUNT);

  return {
    maze: map === null || !exists(map) ? null : win('phone-maze', 'blob-view', [map], 'Maze'),
    values: shown.length === 0 ? null : win('phone-values', 'readouts', shown, 'Values'),
    commands: win('phone-commands', 'commands', []),
    plot: plotted.length === 0 ? null : win('phone-plot', 'plot', plotted, 'Plot'),
    settings:
      settings.length === 0 ? null : win('phone-settings', 'editor', settings, 'Run profile'),
  };
}

/** The windows of a plan that exist, in the order the phone shows them. */
export function planWindows(plan: PhonePlan): readonly ShellWindow[] {
  return [plan.maze, plan.values, plan.commands, plan.plot, plan.settings].filter(
    (entry) => entry !== null
  );
}
