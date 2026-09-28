/**
 * Robot packages shared by the robot-kit tests.
 *
 * @module
 */

import { TypeCode, decodeAccess } from '@/protocol';

import type { RobotPackage, SchemaVariable, SerializableType } from '../types';

/** A grid decoded from its bytes, drawn as a string. */
export const GRID: SerializableType<readonly number[], string> = {
  kind: 'serializable',
  tag: 'grid',
  name: 'Grid',
  decode: (bytes) => [...bytes],
  View: ({ value }) => value.join(','),
};

/** A package for a small mouse, with an enum state, a bitmask profile and a grid. */
export function mouse(overrides: Partial<RobotPackage<string>> = {}): RobotPackage<string> {
  return {
    id: 'mouse',
    displayName: 'Mouse',
    signature: ['state', 'profile'],
    roles: { state: 'state', battery: 'battery' },
    variables: {
      state: {
        labels: {
          kind: 'enum',
          name: 'State',
          options: [
            { value: 0, label: 'IDLE' },
            { value: 1, label: 'RUN' },
          ],
        },
      },
      profile: {
        labels: {
          kind: 'bitmask',
          name: 'Profile',
          flags: [
            { bit: 0, label: 'FAN' },
            { bit: 2, label: 'BOOST' },
          ],
        },
      },
      battery: { unit: 'V', description: 'Pack voltage', color: 'red' },
      grid: { serializable: 'grid' },
    },
    types: [GRID],
    commands: [
      { code: 0, name: 'GO', label: 'Go', acceptedIn: [0] },
      { code: 5, name: 'STOP', label: 'Stop', acceptedIn: 'any', emergency: true },
    ],
    refusalReasons: { 1: 'not idle' },
    presets: [],
    ...overrides,
  };
}

/** A package for a larger robot whose signature contains the mouse's. */
export function sumo(overrides: Partial<RobotPackage<string>> = {}): RobotPackage<string> {
  return {
    ...mouse(),
    id: 'sumo',
    displayName: 'Sumo',
    signature: ['state', 'profile', 'blade'],
    ...overrides,
  };
}

/** A schema entry of a streamed variable. */
export function variable(
  name: string,
  type: TypeCode,
  typeTag: string | null = null
): SchemaVariable {
  return { name, type, access: decodeAccess(0x01), typeTag };
}
