/**
 * The workspaces Micras suggests, after the approved C2 design: a few windows each, side by side
 * in a `row` and stacked in a `column`.
 *
 * @module
 */

import type { LayoutPreset, PresetNode, PresetWindow } from '@/robot-kit';

function window(kind: string, title?: string, variables?: readonly string[]): PresetNode {
  const spec: PresetWindow = {
    kind,
    ...(title === undefined ? {} : { title }),
    ...(variables === undefined ? {} : { variables }),
  };
  return { window: spec };
}

function row(ratio: number, first: PresetNode, second: PresetNode): PresetNode {
  return { split: 'row', ratio, first, second };
}

function column(ratio: number, first: PresetNode, second: PresetNode): PresetNode {
  return { split: 'column', ratio, first, second };
}

const maze = window('type-view', 'Maze', ['maze']);
const speed = window('plot', 'Tracking', ['pose/linear_speed', 'reference/linear_speed']);

/** Overview, Tracking, Sensors and Maze run. */
export const PRESETS: readonly LayoutPreset[] = [
  {
    name: 'Overview',
    root: row(0.6, column(0.6, speed, window('robot')), column(0.6, maze, window('commands'))),
  },
  {
    name: 'Tracking',
    root: column(
      0.5,
      speed,
      window('plot', 'Heading', ['pose/orientation', 'reference/orientation'])
    ),
  },
  {
    name: 'Sensors',
    root: column(
      0.68,
      window('plot', 'Walls', ['wall/0', 'wall/1', 'wall/2', 'wall/3']),
      window('readouts', 'IMU', ['imu/gyro_z', 'imu/accel_x', 'imu/accel_y'])
    ),
  },
  {
    name: 'Maze run',
    root: row(
      0.6,
      maze,
      column(0.5, window('editor', 'Run profile', ['run_profile']), window('log'))
    ),
  },
];
