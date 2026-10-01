/**
 * The port the shell reads the robot's variables from.
 *
 * @module
 */

import type { Variable } from '@/core/variables';

/** The schema of the connected robot. */
export interface SchemaPort {
  /** Every variable, in schema order; empty until a schema is loaded. The same array until it changes. */
  variables(): readonly Variable[];

  /** Calls `listener` after the schema changes; returns the function that stops it. */
  subscribe(listener: () => void): () => void;
}
