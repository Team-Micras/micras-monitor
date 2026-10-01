import { describe, expect, test } from 'vitest';

import type { Variable } from '@/core/variables';
import { filterCounts, filterVariables, groupVariables } from '@/ui/shell/variable-groups';
import { variable } from '@tests/support/core/robot/packages';

function writable(name: string): Variable {
  const base = variable(name, 'f32');
  return { ...base, access: { ...base.access, write: true } };
}

const SCHEMA = [
  variable('pose/x', 'f32'),
  variable('state', 'u8'),
  writable('pose/y'),
  variable('wall/0', 'f32'),
  writable('Gain'),
];

function names(variables: readonly Variable[]): string[] {
  return variables.map(({ name }) => name);
}

describe('groupVariables', () => {
  test('groups by the prefix before the first slash, where the first member was', () => {
    const groups = groupVariables(SCHEMA);
    expect(groups.map((group) => [group.name, names(group.variables)])).toEqual([
      ['pose', ['pose/x', 'pose/y']],
      [null, ['state']],
      ['wall', ['wall/0']],
      [null, ['Gain']],
    ]);
  });

  test('gives nothing for no variables', () => {
    expect(groupVariables([])).toEqual([]);
  });
});

describe('filterVariables', () => {
  const plotted = new Set(['pose/x', 'state']);

  test('keeps the names that contain the search, ignoring case and spaces around it', () => {
    expect(names(filterVariables(SCHEMA, '  POSE ', 'all', plotted))).toEqual(['pose/x', 'pose/y']);
    expect(names(filterVariables(SCHEMA, 'gain', 'all', plotted))).toEqual(['Gain']);
  });

  test('keeps only the variables some window shows, or only the writable ones', () => {
    expect(names(filterVariables(SCHEMA, '', 'plotted', plotted))).toEqual(['pose/x', 'state']);
    expect(names(filterVariables(SCHEMA, '', 'writable', plotted))).toEqual(['pose/y', 'Gain']);
    expect(names(filterVariables(SCHEMA, 'pose', 'writable', plotted))).toEqual(['pose/y']);
  });

  test('counts what each filter lists', () => {
    expect(filterCounts(SCHEMA, plotted)).toEqual({ all: 5, plotted: 2, writable: 2 });
  });
});
