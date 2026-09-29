/**
 * The ports the app talks to the robot through. They are deliberately small: each window reads
 * only what it draws, and the composition root decides what serves each port.
 *
 * @module
 */

import type { CommandPort } from './commands';
import type { ConnectionPort } from './connection';
import type { HistoryPort } from './history';
import type { LinkStatsPort, LogPort } from './link';
import type { ReadPort } from './read';
import type { SchemaPort } from './schema';
import type { StreamPort } from './streams';
import type { ValuesPort } from './values';
import type { WritePort } from './write';

export type * from './commands';
export type * from './connection';
export type * from './history';
export type * from './link';
export type * from './read';
export type * from './schema';
export type * from './streams';
export type * from './values';
export type * from './write';

/** Every port the app needs, as the composition root hands them over. */
export interface MonitorPorts {
  readonly connection: ConnectionPort;
  readonly schema: SchemaPort;
  readonly values: ValuesPort;
  readonly streams: StreamPort;
  readonly history: HistoryPort;
  readonly commands: CommandPort;
  readonly writes: WritePort;
  readonly reads: ReadPort;
  readonly link: LinkStatsPort;
  readonly log: LogPort;
}
