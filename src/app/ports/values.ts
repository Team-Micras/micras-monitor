/**
 * The port the shell reads live values from. The telemetry store implements it once it lands.
 *
 * @module
 */

/** A value as the shell shows it: numbers for numeric variables, the bytes of a blob. */
export type LiveValue = number | Uint8Array;

/** The latest values of the connected robot's variables. */
export interface ValuesPort {
  /** The latest value of a variable, by id, or undefined when none has arrived. */
  latest(id: number): LiveValue | undefined;

  /**
   * Calls `listener` when values changed, at most about ten times a second, which is as often
   * as numbers on screen should change; returns the function that stops it.
   */
  subscribe(listener: () => void): () => void;

  /** A number that changes whenever any value does, for `useSyncExternalStore`. */
  version(): number;
}
