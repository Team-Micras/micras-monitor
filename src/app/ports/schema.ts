/**
 * The port the shell reads the robot's variables from.
 *
 * @module
 */

import type { SchemaVariable } from '@/robot-kit';

/** A variable of the connected robot: its schema entry and the id messages name it by. */
export interface VariableInfo extends SchemaVariable {
  readonly id: number;
}

/** The schema of the connected robot. */
export interface SchemaPort {
  /** Every variable, in schema order; empty until a schema is loaded. The same array until it changes. */
  variables(): readonly VariableInfo[];

  /** Calls `listener` after the schema changes; returns the function that stops it. */
  subscribe(listener: () => void): () => void;
}
