/**
 * The port that reads variables the link does not stream, such as the maze or the results of a
 * calibration, with a READ on demand.
 *
 * @module
 */

import type { Value } from '@/core/variables';

/** How a READ ended: the value, which also becomes the variable's latest, or why it failed. */
export type ReadOutcome =
  | { readonly status: 'ok'; readonly value: Value }
  | { readonly status: 'failed'; readonly message: string };

/** Reads variables on demand. */
export interface ReadPort {
  /**
   * Asks the robot for a variable's value. The answer also lands in the values port as the
   * variable's latest value, without a timestamp.
   *
   * @param name The variable, by name.
   */
  read(name: string): Promise<ReadOutcome>;
}
