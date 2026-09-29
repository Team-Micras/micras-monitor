import { describe, expect, test } from 'vitest';

import {
  acceptedIn,
  enumLabel,
  isIdleState,
  refusalReason,
  RobotRegistry,
  validatePackage,
  type EnumType,
  type PresetNode,
} from '@/robot-kit';

import { Command, Reason } from './commands';
import {
  COMMAND_NAMES,
  COMMAND_TABLE,
  FAULT_NAMES,
  OBJECTIVE_NAMES,
  PROFILE_MASKS,
  REASON_NAMES,
  STATE_NAMES,
  VARIABLE_NAMES,
} from './fixtures/firmware';
import { FsmState, RunProfileBit, stateFromLog } from './labels';
import { micras } from './index';

function labels(name: string): EnumType {
  const spec = micras.variables[name]?.labels;

  if (spec?.kind !== 'enum') {
    throw new Error(`${name} has no enum labels`);
  }

  return spec;
}

function presetVariables(node: PresetNode | null): string[] {
  if (node === null) {
    return [];
  }

  return 'window' in node
    ? [...(node.window.variables ?? [])]
    : [...presetVariables(node.first), ...presetVariables(node.second)];
}

describe('the Micras package', () => {
  test('is consistent', () => {
    expect(() => validatePackage(micras)).not.toThrow();
  });

  test('is chosen by the name the robot announces', () => {
    const registry = new RobotRegistry([micras]);

    expect(registry.select({ name: 'micras', variables: [] })).toMatchObject({
      package: micras,
      matchedBy: 'name',
    });
    expect(registry.select({ name: 'sumo', variables: [...VARIABLE_NAMES] })).toBeNull();
  });

  test('is chosen by the firmware variables when the robot announces no name', () => {
    const registry = new RobotRegistry([micras]);

    expect(registry.select({ name: null, variables: [...VARIABLE_NAMES] })).toMatchObject({
      package: micras,
      matchedBy: 'variables',
    });
    expect(registry.select({ name: null, variables: ['state', 'maze'] })).toBeNull();
  });

  test('presents every variable the firmware registers, and only those', () => {
    expect(Object.keys(micras.variables).toSorted()).toEqual([...VARIABLE_NAMES].toSorted());

    for (const name of VARIABLE_NAMES) {
      expect({ name, described: Boolean(micras.variables[name]?.description) }).toEqual({
        name,
        described: true,
      });
    }
  });

  test('names firmware variables in its roles, signature and presets', () => {
    const known = new Set<string>(VARIABLE_NAMES);
    const named = [
      ...Object.values(micras.roles),
      ...micras.signature,
      ...micras.presets.flatMap((preset) => presetVariables(preset.root)),
    ];

    expect(named.filter((name) => !known.has(name))).toEqual([]);
  });

  test('suggests the four workspaces of the design', () => {
    expect(micras.presets.map((preset) => preset.name)).toEqual([
      'Overview',
      'Tracking',
      'Sensors',
      'Maze run',
    ]);
  });
});

describe('the labels, against the firmware', () => {
  test('number the states as the firmware, BRAKE included', () => {
    expect(labels('state').options.map((option) => option.label)).toEqual([...STATE_NAMES]);
    STATE_NAMES.forEach((name, id) => expect(enumLabel(labels('state'), id)).toBe(name));
    expect(FsmState.BRAKE).toBe(13);
  });

  test('read the transitions the firmware logs, and no other line', () => {
    STATE_NAMES.forEach((name, id) => expect(micras.stateLog?.(`state ${name}`)).toBe(id));
    expect(stateFromLog('state BRAKE')).toBe(FsmState.BRAKE);
    expect(stateFromLog('state NAPPING')).toBeNull();
    expect(stateFromLog('the state IDLE')).toBeNull();
    expect(stateFromLog('state IDLE now')).toBeNull();
  });

  test('number the objectives and the faults as the firmware', () => {
    OBJECTIVE_NAMES.forEach((name, value) =>
      expect(enumLabel(labels('objective'), value)).toBe(name)
    );
    FAULT_NAMES.forEach((name, value) => expect(enumLabel(labels('fault'), value)).toBe(name));
  });

  test('put each switch of the run profile on the bit of its mask', () => {
    const profile = micras.variables.run_profile?.labels;

    expect(profile?.kind).toBe('bitmask');
    const flags = profile?.kind === 'bitmask' ? profile.flags : [];
    expect(Object.fromEntries(flags.map((flag) => [flag.label, 1 << flag.bit]))).toEqual(
      PROFILE_MASKS
    );
    expect(1 << RunProfileBit.BOOST).toBe(PROFILE_MASKS.BOOST);
  });
});

describe('the commands, against the firmware', () => {
  test('carry the firmware codes', () => {
    expect(micras.commands.map((command) => command.name)).toEqual([...COMMAND_NAMES]);
    micras.commands.forEach((command, code) => expect(command.code).toBe(code));
    expect(Command.STOP).toBe(5);
  });

  test('are expected in exactly the states the firmware table accepts them', () => {
    const expected = STATE_NAMES.flatMap((name) =>
      micras.commands.map((command) => [
        name,
        command.name,
        COMMAND_TABLE[name].includes(command.name),
      ])
    );
    const mirrored = STATE_NAMES.flatMap((name, state) =>
      micras.commands.map((command) => [name, command.name, acceptedIn(command, state)])
    );

    expect(mirrored).toEqual(expected);
  });

  test('make STOP the emergency command, accepted in any state', () => {
    const stops = micras.commands.filter((command) => command.emergency === true);

    expect(stops.map((command) => command.name)).toEqual(['STOP']);
    expect(stops[0]?.acceptedIn).toBe('any');
  });

  test('ask before the ones that move the robot, write the flash or lose the pose', () => {
    const confirmed = micras.commands.filter((command) => command.confirm !== undefined);

    expect(confirmed.map((command) => command.name)).toEqual([
      'CALIBRATE',
      'SAVE',
      'RESET',
      'LEAVE_ERROR',
    ]);
  });

  test('say every refusal reason of the firmware in words, and none for NONE', () => {
    REASON_NAMES.forEach((name, reason) => {
      expect(Reason[name]).toBe(reason);
      expect([name, refusalReason(micras, reason) === null]).toEqual([name, name === 'NONE']);
    });
    expect(refusalReason(micras, Reason.NOT_IDLE)).toBe('robot not idle');
  });
});

describe('the idle state', () => {
  test('is the one state in which the robot waits for a command', () => {
    expect(micras.idleStates).toEqual([FsmState.IDLE]);
    expect(isIdleState(micras, FsmState.IDLE)).toBe(true);
    expect(isIdleState(micras, FsmState.RUN)).toBe(false);
  });
});
