/**
 * The monitors the app reads and the hooks it reads them through. There are two: the live one,
 * which the top bar, the connection and the pinned commands always use, and the one the windows
 * show, which is a recording's while one is opened and the live one otherwise.
 *
 * @module
 */

import { createContext, use, useSyncExternalStore, type ReactNode } from 'react';

import type { Monitor, MonitorState } from '@/core/monitor';
import type { SourceStatus, WriteValue } from '@/core/source';
import type { Variable } from '@/core/variables';
import type { LatestValue, HistoryStore } from '@/history';
import type { PackageSelection, RobotPackage, RobotRegistry } from '@/robot-kit';

/** A monitor as the app holds it, over a history store. */
export type AppMonitor = Monitor<HistoryStore>;

/** The robot a window draws with, a React package. */
export type ReactRobotPackage = RobotPackage<ReactNode>;

/**
 * Chooses the robot package for a robot, once per robot name and list of variables, so that the
 * same robot keeps the same selection object.
 */
export class PackageChooser {
  readonly robots: RobotRegistry<ReactNode>;
  readonly #chosen = new WeakMap<
    readonly Variable[],
    Map<string | null, PackageSelection<ReactNode> | null>
  >();

  /**
   * @param robots The packages to choose from.
   */
  constructor(robots: RobotRegistry<ReactNode>) {
    this.robots = robots;
  }

  /** The package for a robot, or null for raw mode or while its variables are not known. */
  choose(name: string | null, variables: readonly Variable[]): PackageSelection<ReactNode> | null {
    if (variables.length === 0) {
      return null;
    }

    const byName = this.#chosen.get(variables) ?? new Map();
    this.#chosen.set(variables, byName);

    if (!byName.has(name)) {
      byName.set(
        name,
        this.robots.select({ name, variables: variables.map((variable) => variable.name) })
      );
    }

    return byName.get(name) ?? null;
  }
}

/** What the app shows from. */
export interface MonitorScope {
  /** The monitor of the connected robot, for whatever acts on it. */
  readonly live: AppMonitor;
  /** The monitor the windows draw: a recording's, or the live one. */
  readonly shown: AppMonitor;
  /** The name of the recording on screen, or null when the windows show the live robot. */
  readonly recording: string | null;
  readonly packages: PackageChooser;
  /** Whether the live monitor's data is synthetic, as with the demo robot. */
  readonly synthetic: boolean;
}

/** How often, at most, a value on screen changes: ten times a second. */
export const LIVE_VALUE_INTERVAL_MS = 100;

/** Carries the {@link MonitorScope} to every component of the app. */
export const MonitorContext = createContext<MonitorScope | null>(null);

/**
 * What the app shows from.
 *
 * @throws {Error} Outside of a `MonitorContext`.
 */
export function useMonitorScope(): MonitorScope {
  const scope = use(MonitorContext);

  if (scope === null) {
    throw new Error('the monitor hooks need a MonitorContext above them');
  }

  return scope;
}

/** The monitor of the connected robot, which commands always go to. */
export function useLiveMonitor(): AppMonitor {
  return useMonitorScope().live;
}

/** The monitor the windows draw: a recording's while one is on screen, the live one otherwise. */
export function useShownMonitor(): AppMonitor {
  return useMonitorScope().shown;
}

/** A part of a monitor's state, rendering again when that part changes. */
export function useMonitorState<T>(monitor: AppMonitor, select: (state: MonitorState) => T): T {
  return useSyncExternalStore(
    (listener) => monitor.subscribe(listener),
    () => select(monitor.state)
  );
}

/** A monitor's status. */
export function useStatus(monitor: AppMonitor): SourceStatus {
  return useMonitorState(monitor, (state) => state.status);
}

/** Whether a monitor's robot is linked: it said who it is and takes commands. */
export function useLinkUp(monitor: AppMonitor): boolean {
  return useMonitorState(monitor, (state) => state.status.kind === 'linked');
}

/** The variables of a monitor's robot, empty while none are known. */
export function useVariables(monitor: AppMonitor): readonly Variable[] {
  return useMonitorState(monitor, (state) => state.variables);
}

/** The package chosen for a monitor's robot, or null for raw mode or no robot. */
export function useRobotPackage(monitor: AppMonitor): PackageSelection<ReactNode> | null {
  const { packages } = useMonitorScope();
  const name = useMonitorState(monitor, (state) => state.identity?.name ?? null);
  return packages.choose(name, useVariables(monitor));
}

/** The newest value written to a variable that the robot has not answered yet. */
export function usePendingWrite(monitor: AppMonitor, name: string): WriteValue | undefined {
  return useSyncExternalStore(
    (listener) => monitor.subscribe(listener),
    () => monitor.pendingWrite(name)
  );
}

/**
 * Follows one variable, calling `listener` at most once per {@link LIVE_VALUE_INTERVAL_MS}: a
 * change inside the interval is delivered at its end.
 *
 * @returns The function that stops following it.
 */
export function subscribeThrottled(
  history: HistoryStore,
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

  const unsubscribe = history.subscribe([name], () => {
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
 * @param monitor The monitor whose history holds it.
 * @param name The variable's name, or null for none.
 */
export function useLiveValue(monitor: AppMonitor, name: string | null): LatestValue | undefined {
  const { history } = monitor;
  return useSyncExternalStore(
    name === null ? noSubscription : (listener) => subscribeThrottled(history, name, listener),
    name === null ? noValue : () => history.latest(name)
  );
}
