import { describe, expect, test } from 'vitest';

import type { ValueType, Variable } from '@/core/variables';
import { mouse } from '@tests/support/core/robot/packages';
import { phonePlan, planWindows } from '@/app/phone/phone-plan';

import { micras } from '@/robots/micras';

let nextId = 0;

function variable(
  name: string,
  type: ValueType = 'f32',
  access = { stream: true, write: false, writeNeedsIdle: false, persists: false }
): Variable {
  nextId += 1;
  return { id: nextId, name, type, access };
}

const MICRAS_SCHEMA: readonly Variable[] = [
  variable('state', 'u8'),
  variable('battery_voltage'),
  variable('pose/linear_speed'),
  variable('reference/linear_speed'),
  variable('pose/orientation'),
  variable('wall/0'),
  variable('objective', 'u8', { stream: true, write: true, writeNeedsIdle: true, persists: false }),
  variable('run_profile', 'u8', {
    stream: true,
    write: true,
    writeNeedsIdle: false,
    persists: false,
  }),
  variable('maze', 'bytes', { stream: false, write: false, writeNeedsIdle: false, persists: true }),
];

describe('phonePlan', () => {
  test('gives Micras its map, two values, a plot, its commands and its writable labelled settings', () => {
    const plan = phonePlan(micras, MICRAS_SCHEMA);

    expect(plan.maze?.payload.variables).toEqual(['maze']);
    expect(plan.values?.payload.variables).toEqual(['pose/linear_speed', 'pose/orientation']);
    expect(plan.plot?.payload.variables).toEqual(['pose/linear_speed', 'reference/linear_speed']);
    expect(plan.settings?.payload.variables).toEqual(['objective', 'run_profile']);
    expect(plan.commands.kind).toBe('commands');
    expect(planWindows(plan).map((window) => window.kind)).toEqual([
      'type-view',
      'readouts',
      'commands',
      'plot',
      'editor',
    ]);
  });

  test('leaves out the map of a robot whose package names none', () => {
    const plan = phonePlan(mouse({ roles: { state: 'state' } }), MICRAS_SCHEMA);

    expect(plan.maze).toBeNull();
  });

  test('never offers the state variable as a setting', () => {
    const schema = [
      variable('state', 'u8', {
        stream: true,
        write: true,
        writeNeedsIdle: false,
        persists: false,
      }),
    ];
    const plan = phonePlan(mouse(), schema);

    expect(plan.settings).toBeNull();
  });

  test('shows an unknown robot its first streamed numbers and nothing it cannot draw', () => {
    const schema = [
      variable('flag', 'bool'),
      variable('blob', 'bytes'),
      variable('hidden', 'f32', {
        stream: false,
        write: false,
        writeNeedsIdle: false,
        persists: false,
      }),
      variable('speed'),
      variable('turn'),
      variable('lift'),
    ];
    const plan = phonePlan(null, schema);

    expect(plan.maze).toBeNull();
    expect(plan.values?.payload.variables).toEqual(['speed', 'turn']);
    expect(plan.plot?.payload.variables).toEqual(['speed', 'turn']);
    expect(plan.settings).toBeNull();
    expect(plan.commands.kind).toBe('commands');
  });

  test('is only the commands for a robot without a schema or a package', () => {
    const plan = phonePlan(null, []);

    expect(planWindows(plan)).toEqual([plan.commands]);
  });

  test('skips variables the connected schema no longer has', () => {
    const schema = MICRAS_SCHEMA.filter((entry) => entry.name !== 'pose/linear_speed');
    const plan = phonePlan(micras, schema);

    expect(plan.plot?.payload.variables).toEqual(['reference/linear_speed']);
    expect(plan.values?.payload.variables).not.toContain('pose/linear_speed');
  });
});
