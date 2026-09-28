/**
 * What the composition root hands the app, the ports and the robot packages, and the hooks the
 * shell reads them through.
 *
 * @module
 */

import { createContext, use, useSyncExternalStore, type ReactNode } from 'react';

import type { PackageSelection, RobotPackage, RobotRegistry } from '@/robot-kit';

import type { ConnectionStatus, LiveValue, MonitorPorts, VariableInfo } from './ports';

/** The robot a window draws with, a React package. */
export type ReactRobotPackage = RobotPackage<ReactNode>;

/** The ports and packages of the running app. */
export interface Monitor {
  readonly ports: MonitorPorts;
  readonly robots: RobotRegistry<ReactNode>;
  /** Whether the values are synthetic, as with the in-memory fake robot. */
  readonly synthetic: boolean;
}

/** Carries the {@link Monitor} to every component of the app. */
export const MonitorContext = createContext<Monitor | null>(null);

/**
 * The monitor of the app.
 *
 * @throws {Error} Outside of a `MonitorContext`.
 */
export function useMonitor(): Monitor {
  const monitor = use(MonitorContext);

  if (monitor === null) {
    throw new Error('useMonitor needs a MonitorContext above it');
  }

  return monitor;
}

/** The connection's status, rendering again when it changes. */
export function useConnectionStatus(): ConnectionStatus {
  const { connection } = useMonitor().ports;
  return useSyncExternalStore(
    (listener) => connection.subscribe(listener),
    () => connection.status()
  );
}

/** The variables of the connected robot's schema, rendering again when it changes. */
export function useVariables(): readonly VariableInfo[] {
  const { schema } = useMonitor().ports;
  return useSyncExternalStore(
    (listener) => schema.subscribe(listener),
    () => schema.variables()
  );
}

/**
 * The latest value of a variable, rendering again at the pace values change on screen.
 *
 * @param id The variable's id, or null for none.
 */
export function useLiveValue(id: number | null): LiveValue | undefined {
  const { values } = useMonitor().ports;
  useSyncExternalStore(
    (listener) => values.subscribe(listener),
    () => values.version()
  );
  return id === null ? undefined : values.latest(id);
}

/** The package chosen for the connected robot, or null for raw mode or no robot. */
export function useRobotPackage(): PackageSelection<ReactNode> | null {
  const { robots } = useMonitor();
  const status = useConnectionStatus();
  const variables = useVariables();

  if (status.kind !== 'streaming') {
    return null;
  }

  return robots.select({
    name: status.robot.name,
    variables: variables.map((variable) => variable.name),
  });
}
