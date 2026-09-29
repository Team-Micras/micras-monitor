/**
 * The commands of Micras (`Command` in `include/micras/command.hpp`), the states that accept each
 * one (`command_table` in `src/command.cpp`) and why the robot refuses them (`Reason`).
 *
 * @module
 */

import type { CommandSpec } from '@/robot-kit';

import { FsmState } from './labels';

/** The codes of the commands on the wire. */
export const Command = {
  EXPLORE: 0,
  SOLVE: 1,
  CALIBRATE: 2,
  SAVE: 3,
  RESET: 4,
  STOP: 5,
  LEAVE_ERROR: 6,
} as const;

/** Why a command was refused or deferred: the reason byte of COMMAND_ACK. */
export const Reason = {
  NONE: 0,
  NOT_IDLE: 1,
  BUSY_SAVING: 2,
  FAULT_FROM_INIT: 3,
  NOT_IN_ERROR: 4,
  SAVE_FAILED: 5,
} as const;

/** Every reason but NONE, in words, keyed by its byte. */
export const REFUSAL_REASONS: Readonly<Record<number, string>> = {
  [Reason.NOT_IDLE]: 'robot not idle',
  [Reason.BUSY_SAVING]: 'busy saving the maze',
  [Reason.FAULT_FROM_INIT]: 'the error came from the start; reset the robot',
  [Reason.NOT_IN_ERROR]: 'robot not in the error state',
  [Reason.SAVE_FAILED]: 'the flash did not take the maze',
};

const IDLE_ONLY = [FsmState.IDLE];

/** The commands, in the order of their codes. */
export const COMMANDS: readonly CommandSpec[] = [
  {
    code: Command.EXPLORE,
    name: 'EXPLORE',
    label: 'Explore',
    icon: 'compass',
    description: 'Search the maze, as a short press of the button does.',
    acceptedIn: IDLE_ONLY,
  },
  {
    code: Command.SOLVE,
    name: 'SOLVE',
    label: 'Solve',
    icon: 'route',
    description: 'Run the fastest route found, as a long press does.',
    acceptedIn: IDLE_ONLY,
  },
  {
    code: Command.CALIBRATE,
    name: 'CALIBRATE',
    label: 'Calibrate',
    icon: 'crosshair',
    description: 'Start the maintenance procedure the switches select.',
    confirm: 'Start the procedure the switches select? The robot may move and turn in place.',
    acceptedIn: IDLE_ONLY,
  },
  {
    code: Command.SAVE,
    name: 'SAVE',
    label: 'Save',
    icon: 'save',
    description: 'Save the maze to the flash.',
    confirm: 'Save the maze to the flash? It replaces the saved one.',
    acceptedIn: IDLE_ONLY,
  },
  {
    code: Command.RESET,
    name: 'RESET',
    label: 'Reset',
    icon: 'rotate-ccw',
    description: 'Put the estimate of the pose back at the start.',
    confirm: 'Reset the pose to the start cell?',
    acceptedIn: IDLE_ONLY,
  },
  {
    code: Command.STOP,
    name: 'STOP',
    label: 'Stop',
    icon: 'octagon-x',
    description: 'Brake to a standstill and end whatever the robot is doing.',
    acceptedIn: 'any',
    emergency: true,
  },
  {
    code: Command.LEAVE_ERROR,
    name: 'LEAVE_ERROR',
    label: 'Leave error',
    icon: 'circle-arrow-out-up-left',
    description: 'Go from the error state back to idle.',
    confirm: 'Leave the error state? The robot will be able to move again.',
    acceptedIn: [FsmState.ERROR],
  },
];
