/**
 * How the variables drawer lists the schema: filtered by a search and by what the user asks for,
 * and grouped by the prefix of their names before the first `/`.
 *
 * @module
 */

import type { Variable } from '@/core/variables';

/** Which variables the drawer lists: all of them, those in a window, or those the robot takes writes of. */
export type VariableFilter = 'all' | 'plotted' | 'writable';

/** The filters, in the order the drawer offers them. */
export const VARIABLE_FILTERS: readonly VariableFilter[] = ['all', 'plotted', 'writable'];

/** Variables that share the prefix of their names, or one variable with no prefix. */
export interface VariableGroup {
  /** The prefix, or null for a variable with none. */
  readonly name: string | null;
  readonly variables: readonly Variable[];
}

function groupOf(name: string): string | null {
  const slash = name.indexOf('/');
  return slash === -1 ? null : name.slice(0, slash);
}

/**
 * Groups variables by the prefix of their names, each group where its first variable was, so
 * that the list keeps the schema's order; a variable with no prefix is a group of its own.
 */
export function groupVariables(variables: readonly Variable[]): readonly VariableGroup[] {
  const groups = new Map<string, Variable[]>();
  const order: VariableGroup[] = [];

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
 * The variables whose names contain the search, ignoring case and the spaces around it, and
 * that pass the filter.
 *
 * @param plotted The names of the variables some window shows.
 */
export function filterVariables(
  variables: readonly Variable[],
  search: string,
  filter: VariableFilter,
  plotted: ReadonlySet<string>
): readonly Variable[] {
  const needle = search.trim().toLowerCase();
  return variables.filter(
    (variable) =>
      (needle === '' || variable.name.toLowerCase().includes(needle)) &&
      (filter !== 'plotted' || plotted.has(variable.name)) &&
      (filter !== 'writable' || variable.access.write)
  );
}

/** How many variables each filter lists, with no search. */
export function filterCounts(
  variables: readonly Variable[],
  plotted: ReadonlySet<string>
): Readonly<Record<VariableFilter, number>> {
  return {
    all: variables.length,
    plotted: variables.filter((variable) => plotted.has(variable.name)).length,
    writable: variables.filter((variable) => variable.access.write).length,
  };
}
