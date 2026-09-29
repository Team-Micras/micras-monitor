/**
 * The ports the windows read while a saved session is on screen: its store for the values and
 * the history, its schema, and inert controls, since a recording takes no commands.
 *
 * @module
 */

import type { ReactNode } from 'react';

import type { PackageSelection, RobotRegistry } from '@/robot-kit';

import type { Monitor, PackageSource } from '../monitor-context';
import type { ConnectionStatus, LinkStats, MonitorPorts } from '../ports';
import type { OpenedSession } from './session-manager';

/** Why a control does nothing while a saved session is on screen. */
export const SAVED_SESSION_MESSAGE =
  'A saved session is on screen: go back to live to control the robot.';

const DISCONNECTED: ConnectionStatus = { kind: 'disconnected' };
const NO_STATS: LinkStats = {
  bytesInPerSecond: 0,
  creditWindow: 0,
  creditOutstanding: 0,
  framesDiscarded: 0,
  samplesDropped: 0,
  rttMs: Number.NaN,
  budget: { bytesPerSecond: 0, used: 0, overBudget: false, planned: [] },
};
const NOTHING: readonly never[] = [];
const noSubscription = () => () => undefined;

function fixedPackage(selection: PackageSelection<ReactNode> | null): PackageSource {
  return { current: () => selection, subscribe: noSubscription };
}

/** The ports of a saved session, read only. */
export function savedSessionPorts(opened: OpenedSession): MonitorPorts {
  const failed = { status: 'failed', message: SAVED_SESSION_MESSAGE } as const;
  return {
    connection: {
      status: () => DISCONNECTED,
      subscribe: noSubscription,
      supports: () => false,
      connect: () => undefined,
      disconnect: () => undefined,
    },
    schema: { variables: () => opened.variables, subscribe: noSubscription },
    values: opened.store,
    history: opened.store,
    streams: { request: () => undefined },
    commands: { send: () => Promise.resolve(failed) },
    writes: {
      write: () => Promise.resolve(failed),
      pending: () => undefined,
      subscribe: noSubscription,
    },
    reads: { read: () => Promise.resolve(failed) },
    link: { stats: () => NO_STATS, subscribe: noSubscription },
    log: { entries: () => NOTHING, subscribe: noSubscription },
  };
}

/**
 * The monitor the windows see while a saved session is on screen, with the package its robot
 * would get.
 */
export function savedSessionMonitor(
  opened: OpenedSession,
  robots: RobotRegistry<ReactNode>
): Monitor {
  const selection = robots.select({
    name: opened.robot,
    variables: opened.variables.map((variable) => variable.name),
  });
  return {
    ports: savedSessionPorts(opened),
    robots,
    selection: fixedPackage(selection),
    synthetic: false,
    savedSession: opened.session.name,
  };
}
