import { describe, expect, test } from 'vitest';

import { GRID, mouse } from './fixtures/packages';
import { validatePackage, type CommandSpec, type RobotPackage } from './index';

function problemOf(pkg: RobotPackage<string>): string {
  try {
    validatePackage(pkg);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }

  return 'valid';
}

const stop: CommandSpec = { code: 5, name: 'STOP', label: 'Stop', acceptedIn: 'any' };

describe('validating a package', () => {
  test('accepts a consistent package', () => {
    expect(problemOf(mouse())).toBe('valid');
  });

  test.each<[string, Partial<RobotPackage<string>>, string]>([
    [
      'a repeated command code',
      { commands: [stop, { ...stop, name: 'HALT' }] },
      'commands[1].code repeats 5',
    ],
    [
      'a repeated command name',
      { commands: [stop, { ...stop, code: 6 }] },
      'commands[1].name repeats "STOP"',
    ],
    ['a code out of a byte', { commands: [{ ...stop, code: 256 }] }, 'commands[0].code must be'],
    [
      'two emergency commands',
      {
        commands: [
          { ...stop, emergency: true },
          { ...stop, code: 6, name: 'HALT', emergency: true },
        ],
      },
      'commands[1].emergency is already set on commands[0]',
    ],
    ['a repeated type tag', { types: [GRID, GRID] }, 'types[1].tag repeats "grid"'],
    [
      'a variable naming an unknown type',
      { variables: { maze: { serializable: 'maze' } } },
      'variables["maze"].serializable names no type of the package ("maze")',
    ],
    [
      'a repeated enum value',
      {
        variables: {
          state: {
            labels: {
              kind: 'enum',
              name: 'State',
              options: [
                { value: 1, label: 'A' },
                { value: 1, label: 'B' },
              ],
            },
          },
        },
      },
      'variables["state"].labels.options[1].value repeats 1',
    ],
    [
      'a bit out of range',
      {
        variables: {
          profile: { labels: { kind: 'bitmask', name: 'P', flags: [{ bit: 53, label: 'X' }] } },
        },
      },
      'variables["profile"].labels.flags[0].bit must be an integer from 0 to 52',
    ],
    [
      'a preset ratio outside (0, 1)',
      {
        presets: [
          {
            name: 'Overview',
            root: {
              split: 'row',
              ratio: 1,
              first: { window: { kind: 'plot' } },
              second: { window: { kind: 'plot' } },
            },
          },
        ],
      },
      'presets[0].root.ratio must lie strictly between 0 and 1',
    ],
    [
      'a repeated preset name',
      {
        presets: [
          { name: 'A', root: null },
          { name: 'A', root: null },
        ],
      },
      'presets[1].name repeats "A"',
    ],
  ])('rejects %s', (_, overrides, message) => {
    expect(problemOf(mouse(overrides))).toContain(message);
  });

  test('names the package in the message', () => {
    expect(problemOf(mouse({ types: [GRID, GRID] }))).toMatch(/^robot package "mouse": /);
  });
});
