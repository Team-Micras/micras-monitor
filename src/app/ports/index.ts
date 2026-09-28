/**
 * The ports the app talks to the robot through. They are deliberately small: the shell needs
 * the connection's status, the schema, the latest values and commands, and nothing else.
 *
 * @module
 */

import type { CommandPort } from './commands';
import type { ConnectionPort } from './connection';
import type { SchemaPort } from './schema';
import type { ValuesPort } from './values';

export type * from './commands';
export type * from './connection';
export type * from './schema';
export type * from './values';

/** Every port the app needs, as the composition root hands them over. */
export interface MonitorPorts {
  readonly connection: ConnectionPort;
  readonly schema: SchemaPort;
  readonly values: ValuesPort;
  readonly commands: CommandPort;
}
