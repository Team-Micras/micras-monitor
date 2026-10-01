import { describe, expect, test } from 'vitest';

import { chordId } from '@/core/chords';
import { GRID, mouse } from '@tests/support/core/robot/packages';
import { validatePackage, type CommandSpec, type RobotPackage } from '@/core/robot';

function problemOf(pkg: RobotPackage<string>): string {
  try {
    validatePackage(pkg, (chord) => (chordId(chord) === 'P' ? 'the app (pause)' : null));
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
      'two commands with one key',
      {
        commands: [
          { ...stop, key: 'Space' },
          { ...stop, code: 6, name: 'HALT', key: 'space' },
        ],
      },
      'commands[1].key is already the key of commands[0]',
    ],
    [
      'one chord written two ways',
      {
        commands: [
          { ...stop, key: 'Alt+Shift+E' },
          { ...stop, code: 6, name: 'HALT', key: 'Shift+Alt+E' },
        ],
      },
      'commands[1].key is already the key of commands[0]',
    ],
    [
      'an empty key',
      { commands: [{ ...stop, key: ' ' }] },
      'commands[0].key must be a non-empty chord',
    ],
    [
      'a key that is not a chord',
      { commands: [{ ...stop, key: 'Hyper+E' }] },
      'commands[0].key must be a non-empty chord',
    ],
    [
      'a key the app uses',
      { commands: [{ ...stop, key: 'P' }] },
      'commands[0].key "P" is already used by the app (pause)',
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
    [
      'an idle state that is not an integer',
      { idleStates: [1.5] },
      'idleStates[0] must be an integer',
    ],
  ])('rejects %s', (_, overrides, message) => {
    expect(problemOf(mouse(overrides))).toContain(message);
  });

  test('names the package in the message', () => {
    expect(problemOf(mouse({ types: [GRID, GRID] }))).toMatch(/^robot package "mouse": /);
  });
});
