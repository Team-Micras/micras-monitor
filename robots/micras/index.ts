/**
 * The package of Micras, the team's micromouse: the labels of its state, objective and run
 * profile, its roles, its commands with the firmware's acceptance table, and units.
 *
 * The maze type with its view and the layout presets arrive with the full package; until then a
 * blob of the maze shows as raw bytes.
 *
 * @module
 */

import type { ReactNode } from 'react';

import type { CommandSpec, EnumType, RobotPackage } from '@/robot-kit';

const IDLE = 1;
const ERROR = 12;

const STATE: EnumType = {
  kind: 'enum',
  name: 'State',
  options: [
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
  ].map((label, value) => ({ value, label })),
};

const OBJECTIVE: EnumType = {
  kind: 'enum',
  name: 'Objective',
  options: [
    { value: 0, label: 'EXPLORE' },
    { value: 1, label: 'RETURN' },
    { value: 2, label: 'SOLVE' },
  ],
};

const COMMANDS: readonly CommandSpec[] = [
  {
    code: 0,
    name: 'EXPLORE',
    label: 'Explore',
    icon: 'compass',
    description: 'Search the maze, as a short press of the button does.',
    acceptedIn: [IDLE],
  },
  {
    code: 1,
    name: 'SOLVE',
    label: 'Solve',
    icon: 'route',
    description: 'Run the fastest route found, as a long press does.',
    acceptedIn: [IDLE],
  },
  {
    code: 2,
    name: 'CALIBRATE',
    label: 'Calibrate',
    icon: 'crosshair',
    description: 'Start the maintenance procedure the switches select.',
    acceptedIn: [IDLE],
  },
  {
    code: 3,
    name: 'SAVE',
    label: 'Save',
    icon: 'save',
    description: 'Save the maze to the flash.',
    confirm: 'Save the maze to the flash? It replaces the saved one.',
    acceptedIn: [IDLE],
  },
  {
    code: 4,
    name: 'RESET',
    label: 'Reset',
    icon: 'rotate-ccw',
    description: 'Put the estimate of the pose back at the start.',
    confirm: 'Reset the pose to the start cell?',
    acceptedIn: [IDLE],
  },
  {
    code: 5,
    name: 'STOP',
    label: 'Stop',
    icon: 'octagon-x',
    description: 'Brake to a standstill and end whatever the robot is doing.',
    acceptedIn: 'any',
    emergency: true,
  },
  {
    code: 6,
    name: 'LEAVE_ERROR',
    label: 'Leave error',
    icon: 'circle-arrow-out-up-left',
    description: 'Go from the error state back to idle.',
    confirm: 'Leave the error state? The robot will be able to move again.',
    acceptedIn: [ERROR],
  },
];

/** The Micras package, registered by the composition root. */
export const micras: RobotPackage<ReactNode> = {
  id: 'micras',
  displayName: 'Micras',
  signature: ['state', 'objective', 'run_profile', 'maze', 'pose/x', 'pose/y'],
  roles: {
    state: 'state',
    battery: 'battery_voltage',
    'pose.x': 'pose/x',
    'pose.y': 'pose/y',
    'pose.heading': 'pose/orientation',
    map: 'maze',
    'map.revision': 'maze/revision',
    'link.dropped': 'link/dropped_samples',
    'link.credit': 'link/credit',
  },
  variables: {
    state: { labels: STATE, description: 'State of the robot' },
    objective: { labels: OBJECTIVE, description: 'What the next run does' },
    run_profile: {
      description: 'Options of the runs',
      labels: {
        kind: 'bitmask',
        name: 'RunProfile',
        flags: [
          { bit: 0, label: 'FAN' },
          { bit: 1, label: 'RACING_LINE' },
          { bit: 2, label: 'BOOST' },
          { bit: 3, label: 'RISKY' },
        ],
      },
    },
    battery_voltage: { unit: 'V', description: 'Battery voltage' },
    'pose/x': { unit: 'm' },
    'pose/y': { unit: 'm' },
    'pose/orientation': { unit: 'rad' },
    'pose/linear_speed': { unit: 'm/s' },
    'pose/angular_speed': { unit: 'rad/s' },
    'reference/x': { unit: 'm' },
    'reference/y': { unit: 'm' },
    'reference/orientation': { unit: 'rad' },
    'reference/linear_speed': { unit: 'm/s' },
    'reference/angular_speed': { unit: 'rad/s' },
    'wall/0': { unit: 'm' },
    'wall/1': { unit: 'm' },
    'wall/2': { unit: 'm' },
    'wall/3': { unit: 'm' },
    'imu/gyro_x': { unit: 'rad/s' },
    'imu/gyro_y': { unit: 'rad/s' },
    'imu/gyro_z': { unit: 'rad/s' },
    'imu/accel_x': { unit: 'm/s²' },
    'imu/accel_y': { unit: 'm/s²' },
    'imu/accel_z': { unit: 'm/s²' },
    'loop/elapsed_time': { unit: 's' },
    'loop/worst_time_us': { unit: 'µs' },
    'control/orientation_error': { unit: 'rad' },
    'link/credit': { unit: 'B' },
  },
  types: [],
  commands: COMMANDS,
  refusalReasons: {
    1: 'robot not idle',
    2: 'busy saving the maze',
    3: 'the error came from the start; reset the robot',
    4: 'robot not in the error state',
    5: 'the flash did not take the maze',
  },
  presets: [],
};
