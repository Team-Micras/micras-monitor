/**
 * What the composition root hands the app, the ports and the robot packages, and the hooks the
 * shell reads them through.
 *
 * @module
 */

import { createContext, use, useSyncExternalStore, type ReactNode } from 'react';

import type { Variable } from '@/core/variables';
import type { PackageSelection, RobotPackage, RobotRegistry } from '@/robot-kit';

import type { ConnectionStatus, LatestValue, MonitorPorts, ValuesPort } from './ports';

/** The robot a window draws with, a React package. */
export type ReactRobotPackage = RobotPackage<ReactNode>;

/** Where the package of the robot on screen comes from: the connection's, or a saved session's. */
export interface PackageSource {
  /** The package chosen, or null for raw mode or no robot; the same object until it changes. */
  current(): PackageSelection<ReactNode> | null;
  /** Calls `listener` after the choice changes; returns the function that stops it. */
  subscribe(listener: () => void): () => void;
}

/** The ports and packages of the running app. */
export interface Monitor {
  readonly ports: MonitorPorts;
  readonly robots: RobotRegistry<ReactNode>;
  /** The package of the connected robot, chosen once per change of connection or schema. */
  readonly selection: PackageSource;
  /** Whether the values are synthetic, as with the in-memory fake robot. */
  readonly synthetic: boolean;
  /** The name of the saved session the windows show instead of the live one, if any. */
  readonly savedSession?: string;
}

/** How often, at most, a value on screen changes: ten times a second. */
export const LIVE_VALUE_INTERVAL_MS = 100;

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

/** Whether the link is up: the robot said who it is and takes commands. */
export function useLinkUp(): boolean {
  return useConnectionStatus().kind === 'linked';
}

/** The variables of the connected robot's schema, rendering again when it changes. */
export function useVariables(): readonly Variable[] {
  const { schema } = useMonitor().ports;
  return useSyncExternalStore(
    (listener) => schema.subscribe(listener),
    () => schema.variables()
  );
}

/**
 * Follows one variable, calling `listener` at most once per {@link LIVE_VALUE_INTERVAL_MS}: a
 * change inside the interval is delivered at its end.
 *
 * @returns The function that stops following it.
 */
export function subscribeThrottled(
  values: ValuesPort,
  name: string,
  listener: () => void,
  intervalMs = LIVE_VALUE_INTERVAL_MS
): () => void {
  let last = Number.NEGATIVE_INFINITY;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const deliver = () => {
    timer = undefined;
    last = performance.now();
    listener();
  };

  const unsubscribe = values.subscribe([name], () => {
    if (timer !== undefined) {
      return;
    }

    const wait = last + intervalMs - performance.now();

    if (wait <= 0) {
      deliver();
    } else {
      timer = setTimeout(deliver, wait);
    }
  });

  return () => {
    clearTimeout(timer);
    unsubscribe();
  };
}

const noSubscription = () => () => undefined;
const noValue = () => undefined;

/**
 * The latest value of a variable and when it was sampled, rendering again at most ten times a
 * second while it changes. The variable is followed by name, so it survives schema changes.
 *
 * @param name The variable's name, or null for none.
 */
export function useLiveValue(name: string | null): LatestValue | undefined {
  const { values } = useMonitor().ports;
  return useSyncExternalStore(
    name === null ? noSubscription : (listener) => subscribeThrottled(values, name, listener),
    name === null ? noValue : () => values.latest(name)
  );
}

/** The package chosen for the connected robot, or null for raw mode or no robot. */
export function useRobotPackage(): PackageSelection<ReactNode> | null {
  const { selection } = useMonitor();
  return useSyncExternalStore(
    (listener) => selection.subscribe(listener),
    () => selection.current()
  );
}
