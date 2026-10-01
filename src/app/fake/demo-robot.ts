/**
 * A fake robot shaped like the team's micromouse, with its real variable names and plausible
 * signals, so the shell can be developed and shown without a robot or the simulation.
 *
 * @module
 */

import type { Access, ValueType } from '@/core/variables';

import { demoMazePosition, demoMazeRecord, demoMazeRevision } from './demo-maze';
import { FakeRobot, type FakeRobotOptions, type FakeVariable } from './fake-robot';

const STREAM: Access = { stream: true, write: false, writeNeedsIdle: false, persists: false };
const STREAM_WRITE: Access = { stream: true, write: true, writeNeedsIdle: false, persists: false };
const STREAM_WRITE_IDLE: Access = {
  stream: true,
  write: true,
  writeNeedsIdle: true,
  persists: false,
};
const PERSIST: Access = { stream: false, write: false, writeNeedsIdle: false, persists: true };
const NONE: Access = { stream: false, write: false, writeNeedsIdle: false, persists: false };

const RUN = 3;
const IDLE = 1;
const STOP = 5;
const NOT_IDLE = 1;
const INIT = 0;
const WAIT_FOR_RUN = 2;

const bootSequence = (t: number) => (t < 0.4 ? INIT : t < 3 ? IDLE : t < 6 ? WAIT_FOR_RUN : RUN);

const f32 = (name: string, signal?: (t: number) => number): FakeVariable => ({
  name,
  type: 'f32',
  access: STREAM,
  signal,
});

const counter = (name: string, rate: number, start = 0): FakeVariable => ({
  name,
  type: 'u32',
  access: STREAM,
  signal: (t) => start + t * rate,
});

const quiet = (name: string, type: ValueType, value: number): FakeVariable => ({
  name,
  type,
  access: NONE,
  signal: () => value,
});

const step = (t: number) => (Math.floor(t / 2.7) % 3 === 1 ? 0.3 : 0.6);
const wall = (phase: number) => (t: number) =>
  0.14 + 0.1 * Math.sin(t * 0.9 + phase) + 0.004 * Math.sin(t * 13 + phase);

/** The variables of the demo robot. */
export const DEMO_VARIABLES: readonly FakeVariable[] = [
  { name: 'state', type: 'u8', access: STREAM, signal: bootSequence },
  ...[0, 1, 2, 3].map((i) => f32(`wall/${i}`, wall(i * 1.7))),
  ...[0, 1, 2, 3].map((i) => f32(`wall_dark/${i}`, (t) => 0.01 + 0.002 * Math.sin(t + i))),
  f32('imu/gyro_x', (t) => 0.02 * Math.sin(t * 3.1)),
  f32('imu/gyro_y', (t) => 0.02 * Math.sin(t * 2.3)),
  f32('imu/gyro_z', (t) => 1.2 * Math.sin(t * 0.8)),
  f32('imu/accel_x', (t) => 0.4 * Math.sin(t * 1.3)),
  f32('imu/accel_y', (t) => 0.1 * Math.sin(t * 1.9)),
  f32('imu/accel_z', (t) => 9.81 + 0.02 * Math.sin(t * 7)),
  f32('battery_voltage', (t) => 12.3 - t * 0.0004 + 0.01 * Math.sin(t * 5)),
  quiet('adc_restarts', 'u32', 0),
  quiet('failed_saves', 'u32', 0),
  quiet('fault', 'u8', 0),
  f32('loop/elapsed_time', () => 0.001),
  { name: 'loop/worst_time_us', type: 'u32', access: STREAM, signal: () => 8 },
  counter('loop/missed_ticks', 0),
  counter('loop/saturated_iterations', 0),
  f32('pose/x', (t) => demoMazePosition(t).x),
  f32('pose/y', (t) => demoMazePosition(t).y),
  f32('pose/orientation', (t) => 1.571 + 0.02 * Math.sin(t * 1.1)),
  f32('pose/linear_speed', (t) => step(t) + 0.008 * Math.sin(t * 11)),
  f32('pose/angular_speed', (t) => 0.012 * Math.sin(t * 2.1)),
  f32('reference/x', (t) => 0.9 + 0.09 * Math.sin(t * 0.2)),
  f32('reference/y', (t) => 1.43 + 0.05 * Math.cos(t * 0.2)),
  f32('reference/orientation', () => 1.571),
  f32('reference/linear_speed', step),
  f32('reference/angular_speed', () => 0),
  f32('control/along_error', (t) => 0.003 * Math.sin(t * 1.7)),
  f32('control/across_error', (t) => 0.002 * Math.sin(t * 2.3)),
  f32('control/orientation_error', (t) => 0.001 * Math.sin(t * 3.7)),
  f32('control/forward_feed_forward', (t) => 1.9 + 0.2 * Math.sin(t)),
  f32('control/rotation_feed_forward', (t) => 0.05 * Math.sin(t)),
  f32('control/forward_feedback', (t) => 0.1 * Math.sin(t * 1.3)),
  f32('control/rotation_feedback', (t) => 0.03 * Math.sin(t * 1.9)),
  f32('localizer/gyroscope_bias', () => 0.0012),
  f32('localizer/position_deviation', (t) => 0.004 + 0.001 * Math.sin(t)),
  f32('localizer/orientation_deviation', (t) => 0.01 + 0.002 * Math.sin(t)),
  f32('localizer/innovation_level', (t) => 0.93 + 0.04 * Math.sin(t * 0.7)),
  counter('localizer/accepted', 142, 99_374),
  counter('localizer/rejected', 0.02, 2),
  counter('localizer/edges', 0.4, 311),
  counter('localizer/recoveries', 0),
  ...[0, 1, 2, 3].map((i) => quiet(`wall_reference/${i}`, 'f32', 0.09 + i * 0.001)),
  ...[0, 1, 2, 3].map((i) => quiet(`wall_spread/${i}`, 'f32', 0.002)),
  f32('route_time', () => 7.42),
  quiet('identification/valid', 'bool', 1),
  quiet('identification/breakaway_voltage', 'f32', 0.61),
  quiet('identification/linear_static_friction', 'f32', 0.18),
  quiet('identification/linear_speed_constant', 'f32', 3.9),
  quiet('identification/linear_acceleration_constant', 'f32', 0.42),
  quiet('identification/angular_static_friction', 'f32', 0.05),
  quiet('identification/angular_speed_constant', 'f32', 0.21),
  quiet('identification/angular_acceleration_constant', 'f32', 0.014),
  quiet('identification/torque_constant', 'f32', 0.0068),
  quiet('identification/resistance', 'f32', 2.4),
  quiet('identification/yaw_inertia', 'f32', 0.00011),
  quiet('gyroscope/scale_valid', 'bool', 1),
  quiet('gyroscope/scale', 'f32', 1.003),
  { name: 'objective', type: 'u8', access: STREAM_WRITE_IDLE, signal: () => 0 },
  { name: 'run_profile', type: 'u8', access: STREAM_WRITE, signal: () => 5 },
  {
    name: 'maze',
    type: 'bytes',
    access: PERSIST,
    tag: 'maze-grid',
    bytes: demoMazeRecord,
  },
  counter('link/dropped_samples', 0.8, 315),
  counter('link/dropped_logs', 0),
  { name: 'link/credit', type: 'u32', access: STREAM, signal: (t) => 86 + 40 * Math.sin(t) },
  counter('link/discarded_frames', 0),
  { name: 'maze/revision', type: 'u32', access: STREAM, signal: demoMazeRevision },
];

/**
 * Creates the demo robot. It boots through IDLE into an exploration, during which every command
 * but STOP is refused as not idle, and so are writes of variables that need the robot idle; STOP
 * brings it to IDLE with the wheels still, after which it accepts everything.
 *
 * @param options Overrides, such as shorter delays for tests.
 */
export function createDemoRobot(options: Partial<FakeRobotOptions> = {}): FakeRobot {
  return new FakeRobot({
    name: 'micras',
    schemaHash: 0x3f9a1c07,
    variables: DEMO_VARIABLES,
    answer: (code, _argument, robot) => {
      if (code === STOP) {
        robot.log('info', 'STOP: braking to a standstill');
        robot.hold('state', IDLE);
        robot.hold('pose/linear_speed', 0);
        robot.hold('reference/linear_speed', 0);
        return { status: 'ok', reason: 0 };
      }

      return robot.valueOf('state') === IDLE
        ? { status: 'ok', reason: 0 }
        : { status: 'refused', reason: NOT_IDLE };
    },
    answerWrite: (name, _value, robot) =>
      DEMO_VARIABLES.find((variable) => variable.name === name)?.access.writeNeedsIdle === true &&
      robot.valueOf('state') !== IDLE
        ? { status: 'refused', reason: 'needs-idle' }
        : { status: 'confirmed' },
    logs: [
      { atSeconds: 0.2, severity: 'info', text: 'boot: micras ready' },
      { atSeconds: 6, severity: 'info', text: 'explore: leaving the start cell' },
      { atSeconds: 9, severity: 'debug', text: 'localizer: wall edge accepted at 1,0' },
      { atSeconds: 14, severity: 'warning', text: 'localizer: innovation above the gate' },
      { atSeconds: 18, severity: 'debug', text: 'maze: revision 14 saved to RAM' },
    ],
    ...options,
  });
}
