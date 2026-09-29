/**
 * The package of Micras, the team's micromouse: its maze, the labels of its state, objective,
 * run profile and fault, its roles, its commands with the firmware's acceptance table, the
 * presentation of its variables and its workspaces.
 *
 * @module
 */

import type { ReactNode } from 'react';

import type { RobotPackage, SerializableType } from '@/robot-kit';

import { COMMANDS, REFUSAL_REASONS } from './commands';
import { FsmState, stateFromLog } from './labels';
import { decodeMaze, MAZE_TYPE_TAG, type Maze } from './maze';
import { LazyMazeView } from './lazy-maze-view';
import { PRESETS } from './presets';
import { VARIABLES } from './variables';

/** The maze, decoded from the firmware's record and drawn as a map. */
export const MAZE_TYPE: SerializableType<Maze, ReactNode> = {
  kind: 'serializable',
  tag: MAZE_TYPE_TAG,
  name: 'Maze',
  follows: ['pose.x', 'pose.y', 'pose.heading'],
  decode: decodeMaze,
  View: LazyMazeView,
};

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
  idleStates: [FsmState.IDLE],
  variables: VARIABLES,
  types: [MAZE_TYPE],
  commands: COMMANDS,
  refusalReasons: REFUSAL_REASONS,
  stateLog: stateFromLog,
  presets: PRESETS,
};
