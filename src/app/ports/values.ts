/**
 * The port the shell reads live values from. It is the reading side of the telemetry store,
 * which implements it as it is.
 *
 * @module
 */

import type { LatestValue, TelemetryValue } from '@/telemetry';

export type { LatestValue, TelemetryValue };

/** How the shell names a variable: by name, followed across schema changes, or by current id. */
export type ValueRef = string | number;

/** The latest values of the connected robot's variables, one subscription per variable. */
export interface ValuesPort {
  /** The latest value of a variable and when it was sampled; the same object until it changes. */
  latest(variable: ValueRef): LatestValue | undefined;

  /** A number that changes whenever the variable's value does, for `useSyncExternalStore`. */
  version(variable: ValueRef): number;

  /**
   * Calls `listener` after any of the variables changed, at most once per tick of the store;
   * returns the function that stops it.
   */
  subscribe(variables: readonly ValueRef[], listener: () => void): () => void;
}
