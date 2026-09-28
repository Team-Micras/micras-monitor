/**
 * The port the shell connects to a robot through. The link's `Session` implements it once it
 * lands; until then an in-memory fake does.
 *
 * @module
 */

/** The transports a robot can be reached over. */
export type Transport = 'websocket' | 'bluetooth';

/** Where to reach a robot. */
export type ConnectionTarget =
  | { readonly transport: 'websocket'; readonly url: string }
  | { readonly transport: 'bluetooth' };

/** What the robot told about itself in the handshake. */
export interface RobotIdentity {
  /** The name HELLO_ACK announces (protocol v2), or null for firmware that sends none. */
  readonly name: string | null;
  readonly schemaHash: number;
}

/**
 * Where the connection is. `connecting` opens the transport, `handshaking` covers everything
 * from HELLO to the first configured stream (schema included), and `failed` is a connection
 * that ended with an error the user has to act on.
 */
export type ConnectionStatus =
  | { readonly kind: 'disconnected' }
  | { readonly kind: 'connecting'; readonly target: ConnectionTarget }
  | { readonly kind: 'handshaking'; readonly target: ConnectionTarget }
  | {
      readonly kind: 'streaming';
      readonly target: ConnectionTarget;
      readonly robot: RobotIdentity;
      /** When streaming started, in `Date.now()` milliseconds. */
      readonly since: number;
    }
  | { readonly kind: 'failed'; readonly target: ConnectionTarget; readonly message: string };

/** Opens and closes the connection to one robot at a time. */
export interface ConnectionPort {
  /** The current status: the same object until the status changes. */
  status(): ConnectionStatus;

  /** Calls `listener` after every change of status; returns the function that stops it. */
  subscribe(listener: () => void): () => void;

  /** Tells whether a transport can be used in this browser. */
  supports(transport: Transport): boolean;

  /**
   * Connects to a robot, closing the current connection first. Progress and failure show in
   * the status. Bluetooth needs to be called from a user gesture.
   */
  connect(target: ConnectionTarget): void;

  /** Closes the connection, if any. */
  disconnect(): void;
}
