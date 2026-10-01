/**
 * The source that reaches a robot over `micras_comm`: a link over WebSocket or Bluetooth and
 * the stream planner that owns its groups, mapped onto the monitor's model.
 *
 * @module
 */

import type { Source, SourceConnection, SourceSink, Target, TargetKind } from '@/core/source';

import { asError } from './link/errors';
import type { LinkTiming } from './link/link-events';
import { RobotLink } from './link/robot-link';
import { MemorySchemaCache, type SchemaCache } from './link/schema';
import {
  closeLink,
  MicrasCommConnection,
  type Link,
  type ParkedLink,
} from './micras-comm-connection';
import { StreamPlanner, type StreamPlannerOptions } from './streaming/stream-planner';
import { BluetoothTransport } from './transports/bluetooth/bluetooth-transport';
import type { BluetoothLike } from './transports/bluetooth/bluetooth-types';
import type { Transport } from './transports/transport';
import { WebSocketTransport, type WebSocketFactory } from './transports/websocket-transport';

/** What the source is built from; everything has a default. */
export interface MicrasCommOptions {
  /** The link's timeouts and periods, over the defaults for a radio link. */
  readonly timing?: Partial<LinkTiming>;
  /** How the stream planner plans. */
  readonly planner?: StreamPlannerOptions;
  /** `navigator.bluetooth`, when the browser has it. */
  readonly bluetooth?: BluetoothLike;
  /** Opens WebSockets; the runtime's own by default. */
  readonly createSocket?: WebSocketFactory;
  /** Where schemas are kept between connections; in memory, for the life of the source, by default. */
  readonly schemaCache?: SchemaCache;
}

const WEBSOCKET_URL = /^wss?:\/\/\S+$/;

/**
 * Reaches robots over `micras_comm`. Each connection gets a link and a stream planner of its
 * own; a Bluetooth link that waits for a click is kept, so that connecting to Bluetooth again
 * reaches the same device instead of asking for another.
 */
export class MicrasCommSource implements Source {
  readonly id = 'micras-comm';
  readonly targets: readonly TargetKind[];
  readonly #options: MicrasCommOptions;
  readonly #schemaCache: SchemaCache;
  #parked: ParkedLink | null = null;

  /**
   * @param options What the source is built from.
   */
  constructor(options: MicrasCommOptions = {}) {
    this.#options = options;
    this.#schemaCache = options.schemaCache ?? new MemorySchemaCache();
    this.targets = options.bluetooth === undefined ? ['websocket'] : ['websocket', 'bluetooth'];
  }

  connect(target: Target, sink: SourceSink): SourceConnection {
    const parked = this.#parked;
    this.#parked = null;
    const connection = new MicrasCommConnection(target, sink, (link) => this.#park(link));

    if (parked !== null && target.transport === 'bluetooth') {
      connection.start(parked);
      return connection;
    }

    if (parked !== null) {
      closeLink(parked);
    }

    if (target.transport === 'websocket') {
      if (WEBSOCKET_URL.test(target.url)) {
        const { createSocket } = this.#options;
        connection.start(this.#link(new WebSocketTransport(target.url, { createSocket })));
      } else {
        connection.fail('Enter a ws:// or wss:// URL.');
      }

      return connection;
    }

    const bluetooth = this.#options.bluetooth;

    if (bluetooth === undefined) {
      connection.fail('Web Bluetooth is not available in this browser.');
      return connection;
    }

    sink.status({ kind: 'connecting', target });
    BluetoothTransport.request({ bluetooth }).then(
      (transport) => connection.start(this.#link(transport)),
      (error: unknown) =>
        error instanceof Error && error.name === 'NotFoundError'
          ? connection.cancel()
          : connection.fail(asError(error).message)
    );
    return connection;
  }

  #link(transport: Transport): Link {
    const link = new RobotLink(transport, {
      timing: this.#options.timing,
      schemaCache: this.#schemaCache,
    });
    return { transport, link, planner: new StreamPlanner(link, this.#options.planner) };
  }

  #park(link: ParkedLink): void {
    if (this.#parked !== null) {
      closeLink(this.#parked);
    }

    this.#parked = link;
  }
}
