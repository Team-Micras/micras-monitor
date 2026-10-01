/**
 * The desktop the shell shows before any robot has linked and when no layouts are kept: the four
 * workspaces of the approved design, with windows of each kind.
 *
 * @module
 */

import { createDesktop, createWorkspace, leaf, split, type Desktop } from '@/tiling';

import type { ShellWindow, WindowPayload } from '../windows/types';

function win(id: string, kind: string, variables: readonly string[] = [], title?: string) {
  const payload: WindowPayload = title === undefined ? { variables } : { title, variables };
  return { id, kind, payload } satisfies ShellWindow;
}

const WINDOWS: readonly ShellWindow[] = [
  win('tracking', 'plot', ['pose/linear_speed', 'reference/linear_speed'], 'Tracking'),
  win('maze', 'blob-view', ['maze'], 'Maze'),
  win('robot', 'robot', ['state', 'battery_voltage']),
  win('commands', 'commands'),
  win('angular', 'plot', ['pose/angular_speed', 'reference/angular_speed'], 'Angular speed'),
  win(
    'errors',
    'plot',
    ['control/along_error', 'control/across_error', 'control/orientation_error'],
    'Errors'
  ),
  win('walls', 'plot', ['wall/0', 'wall/1', 'wall/2', 'wall/3'], 'Walls'),
  win('imu', 'readouts', ['imu/gyro_z', 'imu/accel_x', 'imu/accel_y'], 'IMU'),
  win('maze-run', 'blob-view', ['maze'], 'Maze'),
  win('run-profile', 'editor', ['run_profile'], 'Run profile'),
  win('log', 'log'),
];

/** Builds the starting desktop. */
export function defaultDesktop(): Desktop<WindowPayload> {
  return createDesktop(
    [
      createWorkspace(
        'Overview',
        split(
          'column',
          0.58,
          split('row', 0.6, leaf('tracking'), leaf('maze')),
          split('row', 0.6, leaf('robot'), leaf('commands'))
        )
      ),
      createWorkspace('Tracking', split('column', 0.5, leaf('angular'), leaf('errors'))),
      createWorkspace('Sensors', split('row', 0.64, leaf('walls'), leaf('imu'))),
      createWorkspace(
        'Maze run',
        split('row', 0.6, leaf('maze-run'), split('column', 0.5, leaf('run-profile'), leaf('log')))
      ),
    ],
    WINDOWS
  );
}
