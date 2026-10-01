/**
 * How the monitor presents the variables `Micras::register_variables` publishes: units,
 * descriptions, labels and the colors that keep a signal the same in every window.
 *
 * @module
 */

import type { VariableSpec } from '@/core/robot';

import { FAULT_LABELS, OBJECTIVE_LABELS, RUN_PROFILE_LABELS, STATE_LABELS } from './labels';
import { MAZE_TYPE_TAG } from './maze';

const MEASURED = 'var(--chart-1)';
const REFERENCE = 'var(--chart-2)';
const SERIES = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)'];
const WALL_SENSORS = ['left front', 'left', 'right', 'right front'];

function perWallSensor(
  prefix: string,
  spec: (sensor: string) => VariableSpec
): Record<string, VariableSpec> {
  return Object.fromEntries(
    WALL_SENSORS.map((sensor, index) => [
      `${prefix}/${index}`,
      { color: SERIES[index], ...spec(sensor) },
    ])
  );
}

/** The presentation of every variable of Micras, by name. */
export const VARIABLES: Readonly<Record<string, VariableSpec>> = {
  state: { labels: STATE_LABELS, description: 'State of the state machine' },
  ...perWallSensor('wall', (sensor) => ({
    unit: 'm',
    description: `Distance the ${sensor} wall sensor reads`,
  })),
  ...perWallSensor('wall_dark', (sensor) => ({
    description: `Reading of the ${sensor} wall sensor with its emitter off`,
  })),
  'imu/gyro_x': { unit: 'rad/s', description: 'Angular velocity about the X axis of the IMU' },
  'imu/gyro_y': { unit: 'rad/s', description: 'Angular velocity about the Y axis of the IMU' },
  'imu/gyro_z': { unit: 'rad/s', description: 'Yaw rate', color: MEASURED },
  'imu/accel_x': {
    unit: 'm/s²',
    description: 'Acceleration along the X axis of the IMU, to the right',
  },
  'imu/accel_y': { unit: 'm/s²', description: 'Acceleration along the Y axis of the IMU, forward' },
  'imu/accel_z': { unit: 'm/s²', description: 'Acceleration along the Z axis of the IMU, up' },
  battery_voltage: { unit: 'V', description: 'Battery voltage' },
  adc_restarts: { description: 'Times the ADC was restarted' },
  failed_saves: { description: 'Saves of the maze the flash did not take' },
  fault: { labels: FAULT_LABELS, description: 'What made the robot stop' },
  'loop/elapsed_time': { unit: 's', description: 'Time since the previous iteration of the loop' },
  'loop/worst_time_us': { unit: 'µs', description: 'Longest iteration of the loop' },
  'loop/missed_ticks': { description: 'Periods of the loop that went by without an iteration' },
  'loop/saturated_iterations': { description: 'Iterations the motors could not deliver' },
  'pose/x': {
    unit: 'm',
    description: 'Estimated position, to the right of the start corner',
    color: MEASURED,
  },
  'pose/y': {
    unit: 'm',
    description: 'Estimated position, ahead of the start corner',
    color: MEASURED,
  },
  'pose/orientation': {
    unit: 'rad',
    description: 'Estimated heading, 0 to the right',
    color: MEASURED,
  },
  'pose/linear_speed': { unit: 'm/s', description: 'Estimated forward speed', color: MEASURED },
  'pose/angular_speed': { unit: 'rad/s', description: 'Estimated turning rate', color: MEASURED },
  'reference/x': { unit: 'm', description: 'Position the robot should be at', color: REFERENCE },
  'reference/y': { unit: 'm', description: 'Position the robot should be at', color: REFERENCE },
  'reference/orientation': {
    unit: 'rad',
    description: 'Heading the robot should have',
    color: REFERENCE,
  },
  'reference/linear_speed': {
    unit: 'm/s',
    description: 'Forward speed the robot should have',
    color: REFERENCE,
  },
  'reference/angular_speed': {
    unit: 'rad/s',
    description: 'Turning rate the robot should have',
    color: REFERENCE,
  },
  'control/along_error': { unit: 'm', description: 'Error along the path', color: SERIES[0] },
  'control/across_error': { unit: 'm', description: 'Error across the path', color: SERIES[1] },
  'control/orientation_error': {
    unit: 'rad',
    description: 'Error of the heading',
    color: SERIES[2],
  },
  'control/forward_feed_forward': {
    unit: 'V',
    description: 'Planned voltage of the forward motion',
  },
  'control/rotation_feed_forward': { unit: 'V', description: 'Planned voltage of the rotation' },
  'control/forward_feedback': { unit: 'V', description: 'Correction of the forward motion' },
  'control/rotation_feedback': { unit: 'V', description: 'Correction of the rotation' },
  'localizer/gyroscope_bias': { unit: 'rad/s', description: 'Estimated bias of the gyroscope' },
  'localizer/position_deviation': { unit: 'm', description: 'Uncertainty of the position' },
  'localizer/orientation_deviation': { unit: 'rad', description: 'Uncertainty of the heading' },
  'localizer/innovation_level': {
    description: 'How far the wall readings are from the prediction',
  },
  'localizer/accepted': { description: 'Wall readings the localizer used' },
  'localizer/rejected': { description: 'Wall readings the localizer rejected' },
  'localizer/edges': { description: 'Wall edges the localizer used' },
  'localizer/recoveries': { description: 'Times the localizer recovered from a lost pose' },
  ...perWallSensor('wall_reference', (sensor) => ({
    description: `Calibrated reading of the ${sensor} wall sensor`,
  })),
  ...perWallSensor('wall_spread', (sensor) => ({
    description: `Spread of the calibration of the ${sensor} wall sensor`,
  })),
  route_time: { unit: 's', description: 'Planned time of the fast run' },
  'identification/valid': { description: 'Whether the last drive identification succeeded' },
  'identification/breakaway_voltage': { unit: 'V', description: 'Voltage that starts the wheels' },
  'identification/linear_static_friction': {
    unit: 'V',
    description: 'Static friction of the forward motion',
  },
  'identification/linear_speed_constant': {
    unit: 'V·s/m',
    description: 'Voltage per unit of forward speed',
  },
  'identification/linear_acceleration_constant': {
    unit: 'V·s²/m',
    description: 'Voltage per unit of forward acceleration',
  },
  'identification/angular_static_friction': {
    unit: 'V',
    description: 'Static friction of the rotation',
  },
  'identification/angular_speed_constant': {
    unit: 'V·s/rad',
    description: 'Voltage per unit of turning rate',
  },
  'identification/angular_acceleration_constant': {
    unit: 'V·s²/rad',
    description: 'Voltage per unit of angular acceleration',
  },
  'identification/torque_constant': { unit: 'N·m/A', description: 'Torque constant of the motors' },
  'identification/resistance': { unit: 'Ω', description: 'Resistance of the motors' },
  'identification/yaw_inertia': {
    unit: 'kg·m²',
    description: 'Moment of inertia about the yaw axis',
  },
  'gyroscope/scale_valid': { description: 'Whether the last gyroscope calibration succeeded' },
  'gyroscope/scale': { description: 'Factor that corrects the sensitivity of the gyroscope' },
  objective: { labels: OBJECTIVE_LABELS, description: 'What the next run does' },
  run_profile: { labels: RUN_PROFILE_LABELS, description: 'Switches of the fast runs' },
  maze: { serializable: MAZE_TYPE_TAG, description: 'Walls of the maze as the robot knows them' },
  'maze/revision': {
    description: 'Changes of the maze since boot; the view reads it again when it moves',
  },
  'link/dropped_samples': { description: 'Samples the robot could not send' },
  'link/dropped_logs': { description: 'Log lines the robot could not send' },
  'link/credit': { unit: 'B', description: 'Bytes the robot may still send' },
  'link/discarded_frames': { description: 'Frames the robot discarded as corrupt' },
};
