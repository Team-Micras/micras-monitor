/**
 * Robot packages shared by the robot-kit tests.
 *
 * @module
 */

import type { ValueType, Variable } from '@/core/variables';
import type { RobotPackage, SerializableType } from '@/robot-kit/types';

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
      {
        code: 5,
        name: 'STOP',
        label: 'Stop',
        acceptedIn: 'any',
        pinned: true,
        key: 'Space',
        tone: 'danger',
      },
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

let nextId = 0;

/** A streamed variable, with a fresh id. */
export function variable(name: string, type: ValueType, tag?: string): Variable {
  nextId += 1;
  const access = { stream: true, write: false, writeNeedsIdle: false, persists: false };
  return tag === undefined
    ? { id: nextId, name, type, access }
    : { id: nextId, name, type, access, tag };
}
