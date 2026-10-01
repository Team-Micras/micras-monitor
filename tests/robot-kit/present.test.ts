import { describe, expect, test } from 'vitest';

import { GRID, mouse, variable } from '@tests/support/robot-kit/packages';
import {
  acceptedIn,
  activeFlags,
  emergencyCommand,
  enumLabel,
  hasBit,
  isIdleState,
  presentVariable,
  refusalReason,
  roleVariable,
  type BitmaskType,
  type EnumType,
} from '@/robot-kit';

const pkg = mouse();

describe('presenting a variable', () => {
  test('raw mode shows the value type and nothing else', () => {
    expect(presentVariable(null, variable('battery', 'f32'))).toEqual({
      typeLabel: 'f32',
      unit: null,
      description: null,
      color: null,
      labels: null,
      serializable: null,
    });
  });

  test('a known variable gets its unit, description and color', () => {
    const presentation = presentVariable(pkg, variable('battery', 'f32'));
    expect(presentation).toMatchObject({ unit: 'V', description: 'Pack voltage', color: 'red' });
  });

  test('an integer variable with labels is named by them', () => {
    const presentation = presentVariable(pkg, variable('state', 'u8'));
    expect(presentation.typeLabel).toBe('State');
    expect(presentation.labels?.kind).toBe('enum');
  });

  test('labels do not apply to a variable that is not an integer', () => {
    const presentation = presentVariable(pkg, variable('state', 'f32'));
    expect(presentation.labels).toBeNull();
    expect(presentation.typeLabel).toBe('f32');
  });

  test("a blob is typed by the schema's tag first", () => {
    const presentation = presentVariable(pkg, variable('other', 'bytes', 'grid'));
    expect(presentation.serializable).toBe(GRID);
    expect(presentation.typeLabel).toBe('Grid');
  });

  test('a blob without a tag is typed by the package', () => {
    expect(presentVariable(pkg, variable('grid', 'bytes')).serializable).toBe(GRID);
  });

  test('a blob of an unknown type shows its tag, or the value type without one', () => {
    expect(presentVariable(pkg, variable('x', 'bytes', 'lidar')).typeLabel).toBe('lidar');
    expect(presentVariable(null, variable('x', 'bytes')).typeLabel).toBe('blob');
  });
});

describe('labels of values', () => {
  const state: EnumType = {
    kind: 'enum',
    name: 'State',
    options: [{ value: 3, label: 'RUN' }],
  };
  const profile: BitmaskType = {
    kind: 'bitmask',
    name: 'Profile',
    flags: [
      { bit: 0, label: 'FAN' },
      { bit: 1, label: 'LINE' },
      { bit: 40, label: 'HIGH' },
    ],
  };

  test('an enum value gets its label, an unknown one its number', () => {
    expect(enumLabel(state, 3)).toBe('RUN');
    expect(enumLabel(state, 9)).toBe('9');
  });

  test('bits are read exactly past 32 bits', () => {
    expect(hasBit(2 ** 40 + 1, 40)).toBe(true);
    expect(hasBit(2 ** 40 + 1, 1)).toBe(false);
    expect(activeFlags(profile, 2 ** 40 + 1).map((flag) => flag.label)).toEqual(['FAN', 'HIGH']);
  });
});

describe('roles and commands', () => {
  test('roles name variables, and raw mode has none', () => {
    expect(roleVariable(pkg, 'battery')).toBe('battery');
    expect(roleVariable(pkg, 'map')).toBeNull();
    expect(roleVariable(null, 'state')).toBeNull();
  });

  test('the emergency command is found, and raw mode has none', () => {
    expect(emergencyCommand(pkg)?.name).toBe('STOP');
    expect(emergencyCommand(mouse({ commands: [] }))).toBeNull();
    expect(emergencyCommand(null)).toBeNull();
  });

  test('acceptance follows the table, and is unknown without a state', () => {
    const [go, stop] = pkg.commands;
    expect(acceptedIn(go, 0)).toBe(true);
    expect(acceptedIn(go, 1)).toBe(false);
    expect(acceptedIn(go, null)).toBeNull();
    expect(acceptedIn(stop, null)).toBe(true);
  });

  test('refusal reasons are named by the package', () => {
    expect(refusalReason(pkg, 1)).toBe('not idle');
    expect(refusalReason(pkg, 7)).toBeNull();
    expect(refusalReason(pkg, null)).toBeNull();
    expect(refusalReason(null, 1)).toBeNull();
  });
});

describe('idle states', () => {
  test('takes the states a package declares', () => {
    expect(isIdleState(mouse({ idleStates: [1] }), 1)).toBe(true);
    expect(isIdleState(mouse({ idleStates: [1] }), 0)).toBe(false);
  });

  test('falls back to the state label IDLE, in any case', () => {
    expect(isIdleState(pkg, 0)).toBe(true);
    expect(isIdleState(pkg, 1)).toBe(false);
  });

  test('cannot tell without a package, a state role or a label for the value', () => {
    expect(isIdleState(null, 0)).toBeNull();
    expect(isIdleState(mouse({ roles: {} }), 0)).toBeNull();
    expect(isIdleState(pkg, 9)).toBeNull();
  });
});
