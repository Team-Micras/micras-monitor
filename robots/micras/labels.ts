/**
 * The integer vocabularies of Micras, with the values of the firmware: the state of its state
 * machine (`State` in `include/micras/states/base.hpp`), the objective of a run
 * (`core::Objective`), the run profile's switches (`Interface::Profile`) and the fault that
 * stopped it (`Micras::Fault`).
 *
 * @module
 */

import type { BitmaskType, EnumType } from '@/robot-kit';

/** The states of the robot, by the firmware's ids. */
export const FsmState = {
  INIT: 0,
  IDLE: 1,
  WAIT_FOR_RUN: 2,
  RUN: 3,
  PLAN: 4,
  SAVE: 5,
  WAIT_FOR_CALIBRATE: 6,
  CALIBRATE: 7,
  WAIT_FOR_IDENTIFY: 8,
  IDENTIFY: 9,
  WAIT_FOR_GYROSCOPE: 10,
  CALIBRATE_GYROSCOPE: 11,
  ERROR: 12,
  BRAKE: 13,
} as const;

/** A state of the robot. */
export type FsmState = (typeof FsmState)[keyof typeof FsmState];

const STATE_DESCRIPTIONS: Readonly<Record<keyof typeof FsmState, string>> = {
  INIT: 'Starting up',
  IDLE: 'Waiting for a command',
  WAIT_FOR_RUN: 'Counting down to a run',
  RUN: 'Running',
  PLAN: 'Planning the route of a fast run',
  SAVE: 'Saving the maze to the flash',
  WAIT_FOR_CALIBRATE: 'Counting down to the wall sensor calibration',
  CALIBRATE: 'Calibrating the wall sensors',
  WAIT_FOR_IDENTIFY: 'Counting down to the drive identification',
  IDENTIFY: 'Measuring the drive train',
  WAIT_FOR_GYROSCOPE: 'Counting down to the gyroscope calibration',
  CALIBRATE_GYROSCOPE: 'Measuring the gyroscope scale',
  ERROR: 'Stopped by a fault',
  BRAKE: 'Braking to a standstill after a stop',
};

function enumOf(
  name: string,
  values: Readonly<Record<string, number>>,
  descriptions: Readonly<Record<string, string>> = {}
): EnumType {
  return {
    kind: 'enum',
    name,
    options: Object.entries(values).map(([label, value]) => {
      const description = descriptions[label];
      return description === undefined ? { value, label } : { value, label, description };
    }),
  };
}

/** Labels of the `state` variable. */
export const STATE_LABELS: EnumType = enumOf('FsmState', FsmState, STATE_DESCRIPTIONS);

/** What a run does, by the firmware's values of `core::Objective`. */
export const Objective = {
  EXPLORE: 0,
  RETURN: 1,
  SOLVE: 2,
} as const;

/** Labels of the `objective` variable. */
export const OBJECTIVE_LABELS: EnumType = enumOf('Objective', Objective, {
  EXPLORE: 'Search the maze',
  RETURN: 'Go back to the start',
  SOLVE: 'Run the fastest route',
});

/** The bits of the run profile, one per DIP switch (`Interface::Profile`). */
export const RunProfileBit = {
  FAN: 0,
  RACING_LINE: 1,
  BOOST: 2,
  RISKY: 3,
} as const;

/** Labels of the `run_profile` variable. */
export const RUN_PROFILE_LABELS: BitmaskType = {
  kind: 'bitmask',
  name: 'RunProfile',
  flags: [
    { bit: RunProfileBit.FAN, label: 'FAN', description: 'Run the fan for downforce' },
    {
      bit: RunProfileBit.RACING_LINE,
      label: 'RACING_LINE',
      description: 'Drive the racing line through the cells of the route',
    },
    { bit: RunProfileBit.BOOST, label: 'BOOST', description: 'Ask for more of the traction' },
    { bit: RunProfileBit.RISKY, label: 'RISKY', description: 'Use the turns with less margin' },
  ],
};

/** What made the robot stop, by the firmware's values of `Micras::Fault`. */
export const Fault = {
  NONE: 0,
  CRASH: 1,
  SATURATION: 2,
  IMU: 3,
  INITIALIZATION: 4,
} as const;

/** Labels of the `fault` variable. */
export const FAULT_LABELS: EnumType = enumOf('Fault', Fault, {
  NONE: 'No fault',
  CRASH: 'An acceleration over the crash threshold',
  SATURATION: 'The motors saturated for too long',
  IMU: 'The inertial measurement unit went silent',
  INITIALIZATION: 'The start failed',
});
