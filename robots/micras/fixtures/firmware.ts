/**
 * What the Micras firmware declares, copied from MicrasFirmware `feature/link-protocol-v2`
 * (8ae3bbd) so that the tests hold the package to it. A change in the firmware changes this file,
 * and the tests say what of the package has to follow.
 *
 * @module
 */

/** `state_names` of `include/micras/states/base.hpp`, indexed by the id of the state. */
export const STATE_NAMES = [
  'INIT',
  'IDLE',
  'WAIT_FOR_RUN',
  'RUN',
  'PLAN',
  'SAVE',
  'WAIT_FOR_CALIBRATE',
  'CALIBRATE',
  'WAIT_FOR_IDENTIFY',
  'IDENTIFY',
  'WAIT_FOR_GYROSCOPE',
  'CALIBRATE_GYROSCOPE',
  'ERROR',
  'BRAKE',
] as const;

/** `Command` of `include/micras/command.hpp`, indexed by its code. */
export const COMMAND_NAMES = [
  'EXPLORE',
  'SOLVE',
  'CALIBRATE',
  'SAVE',
  'RESET',
  'STOP',
  'LEAVE_ERROR',
] as const;

/** `Reason` of `include/micras/command.hpp`, indexed by its byte. */
export const REASON_NAMES = [
  'NONE',
  'NOT_IDLE',
  'BUSY_SAVING',
  'FAULT_FROM_INIT',
  'NOT_IN_ERROR',
  'SAVE_FAILED',
] as const;

/** `core::Objective` of `micras_core/include/micras/core/types.hpp`, indexed by its value. */
export const OBJECTIVE_NAMES = ['EXPLORE', 'RETURN', 'SOLVE'] as const;

/** `Micras::Fault` of `include/micras/micras.hpp`, indexed by its value. */
export const FAULT_NAMES = ['NONE', 'CRASH', 'SATURATION', 'IMU', 'INITIALIZATION'] as const;

/** `Interface::Profile` of `include/micras/interface.hpp`: the mask of each switch. */
export const PROFILE_MASKS = { FAN: 1, RACING_LINE: 2, BOOST: 4, RISKY: 8 } as const;

const BUSY = ['STOP'] as const;

/** `command_table` of `src/command.cpp`: the commands each state accepts, once entered. */
export const COMMAND_TABLE: Readonly<Record<(typeof STATE_NAMES)[number], readonly string[]>> = {
  INIT: BUSY,
  IDLE: ['EXPLORE', 'SOLVE', 'CALIBRATE', 'SAVE', 'RESET', 'STOP'],
  WAIT_FOR_RUN: BUSY,
  RUN: BUSY,
  PLAN: BUSY,
  SAVE: BUSY,
  WAIT_FOR_CALIBRATE: BUSY,
  CALIBRATE: BUSY,
  WAIT_FOR_IDENTIFY: BUSY,
  IDENTIFY: BUSY,
  WAIT_FOR_GYROSCOPE: BUSY,
  CALIBRATE_GYROSCOPE: BUSY,
  ERROR: ['STOP', 'LEAVE_ERROR'],
  BRAKE: BUSY,
};

/**
 * Every variable the firmware registers, in the order of the schema: `Micras::register_variables`
 * of `src/micras.cpp`, with `Link::register_variables` of `micras_comm/src/link.cpp` under `link/`.
 */
export const VARIABLE_NAMES = [
  'state',
  'wall/0',
  'wall/1',
  'wall/2',
  'wall/3',
  'wall_dark/0',
  'wall_dark/1',
  'wall_dark/2',
  'wall_dark/3',
  'imu/gyro_x',
  'imu/gyro_y',
  'imu/gyro_z',
  'imu/accel_x',
  'imu/accel_y',
  'imu/accel_z',
  'battery_voltage',
  'adc_restarts',
  'failed_saves',
  'fault',
  'loop/elapsed_time',
  'loop/worst_time_us',
  'loop/missed_ticks',
  'loop/saturated_iterations',
  'pose/x',
  'pose/y',
  'pose/orientation',
  'pose/linear_speed',
  'pose/angular_speed',
  'reference/x',
  'reference/y',
  'reference/orientation',
  'reference/linear_speed',
  'reference/angular_speed',
  'control/along_error',
  'control/across_error',
  'control/orientation_error',
  'control/forward_feed_forward',
  'control/rotation_feed_forward',
  'control/forward_feedback',
  'control/rotation_feedback',
  'localizer/gyroscope_bias',
  'localizer/position_deviation',
  'localizer/orientation_deviation',
  'localizer/innovation_level',
  'localizer/accepted',
  'localizer/rejected',
  'localizer/edges',
  'localizer/recoveries',
  'wall_reference/0',
  'wall_reference/1',
  'wall_reference/2',
  'wall_reference/3',
  'wall_spread/0',
  'wall_spread/1',
  'wall_spread/2',
  'wall_spread/3',
  'route_time',
  'identification/valid',
  'identification/breakaway_voltage',
  'identification/linear_static_friction',
  'identification/linear_speed_constant',
  'identification/linear_acceleration_constant',
  'identification/angular_static_friction',
  'identification/angular_speed_constant',
  'identification/angular_acceleration_constant',
  'identification/torque_constant',
  'identification/resistance',
  'identification/yaw_inertia',
  'gyroscope/scale_valid',
  'gyroscope/scale',
  'objective',
  'run_profile',
  'maze',
  'link/dropped_samples',
  'link/dropped_logs',
  'link/credit',
  'link/discarded_frames',
  'maze/revision',
] as const;
