/**
 * The variables of a window as it draws them: their schema entries, what the robot package says
 * about them, and the color of each series.
 *
 * @module
 */

import type { ReactNode } from 'react';

import { presentVariable, type VariablePresentation } from '@/robot-kit';

import { useRobotPackage, useVariables } from '../../monitor-context';
import type { RobotVariable } from '../../ports';

/** A variable of a window, found in the schema or not. */
export interface PresentedVariable {
  readonly name: string;
  /** Its schema entry, or undefined when the connected robot has no such variable. */
  readonly variable: RobotVariable | undefined;
  /** How the package presents it, or null when it is not in the schema. */
  readonly presentation: VariablePresentation<ReactNode> | null;
  /** The CSS color of its series. */
  readonly color: string;
  /**
   * Whether a schema is loaded and has no such variable, as when the firmware dropped it. Without
   * a schema, as while disconnected, nothing is missing: the variable is only not known yet.
   */
  readonly missing: boolean;
}

/** How many colors the theme has for series, `--chart-1` to `--chart-5`. */
export const SERIES_PALETTE_SIZE = 5;

/** The CSS color of the series at an index: the package's color, else the theme's palette. */
export function seriesColor(index: number, override: string | null = null): string {
  return override ?? `var(--chart-${(index % SERIES_PALETTE_SIZE) + 1})`;
}

/** The variables of a window by name, in order, with their presentation and series color. */
export function usePresentedVariables(names: readonly string[]): readonly PresentedVariable[] {
  const variables = useVariables();
  const pkg = useRobotPackage()?.package ?? null;

  return names.map((name, index) => {
    const variable = variables.find((entry) => entry.name === name);
    const presentation = variable === undefined ? null : presentVariable(pkg, variable);
    return {
      name,
      variable,
      presentation,
      color: seriesColor(index, presentation?.color ?? null),
      missing: variable === undefined && variables.length > 0,
    };
  });
}
