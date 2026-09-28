/**
 * The commands of the Micras firmware and the states that accept them, as `command.hpp` and
 * `command.cpp` define them. They belong to the robot, not to the link, which carries them as
 * plain bytes.
 *
 * @module
 */

/** A command the link can ask the robot to run. */
export enum Command {
  EXPLORE = 0,
  SOLVE = 1,
  CALIBRATE = 2,
  SAVE = 3,
  RESET = 4,
  STOP = 5,
  LEAVE_ERROR = 6,
}

/** Why a command was refused or deferred. */
export enum Reason {
  NONE = 0,
  NOT_IDLE = 1,
  BUSY_SAVING = 2,
  FAULT_FROM_INIT = 3,
  NOT_IN_ERROR = 4,
  SAVE_FAILED = 5,
}

/** The states of the robot the simulation goes through. */
export enum RobotState {
  IDLE = 'IDLE',
  RUN = 'RUN',
  CALIBRATE = 'CALIBRATE',
  SAVE = 'SAVE',
  ERROR = 'ERROR',
}

const COMMAND_COUNT = 7;

const BUSY: ReadonlySet<Command> = new Set([Command.STOP]);

/** The commands each state accepts, as `command_table` in `command.cpp`. */
const ACCEPTED: Readonly<Record<RobotState, ReadonlySet<Command>>> = {
  [RobotState.IDLE]: new Set([
    Command.EXPLORE,
    Command.SOLVE,
    Command.CALIBRATE,
    Command.SAVE,
    Command.RESET,
    Command.STOP,
  ]),
  [RobotState.RUN]: BUSY,
  [RobotState.CALIBRATE]: BUSY,
  [RobotState.SAVE]: BUSY,
  [RobotState.ERROR]: new Set([Command.STOP, Command.LEAVE_ERROR]),
};

/**
 * The command a code stands for.
 *
 * @returns The command, or null when no command has that code.
 */
export function toCommand(code: number): Command | null {
  return Number.isInteger(code) && code >= 0 && code < COMMAND_COUNT ? code : null;
}

/**
 * Why a state refuses a command, from the table alone, as `refusal` in `command.cpp`.
 *
 * @returns The reason, or null when the state accepts the command.
 */
export function refusal(state: RobotState, command: Command): Reason | null {
  if (ACCEPTED[state].has(command)) {
    return null;
  }

  if (command === Command.LEAVE_ERROR) {
    return Reason.NOT_IN_ERROR;
  }

  return state === RobotState.SAVE ? Reason.BUSY_SAVING : Reason.NOT_IDLE;
}
