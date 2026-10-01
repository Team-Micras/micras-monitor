import { Emitter, type Listener, type Unsubscribe } from '@/core/emitter';

/** Why a transport is not open. */
export type CloseReason =
  /** It was never opened. */
  | 'not-opened'
  /** `close()` was called. */
  | 'closed-by-user'
  /** An open connection dropped. */
  | 'lost'
  /** A connection attempt did not succeed. */
  | 'failed'
  /** Reconnecting needs the browser to see a user gesture first. */
  | 'needs-user-gesture'
  /** Another monitor took the link, so this one stays off it until opened again. */
  | 'taken-over';

/** Where a transport is in its life. */
export type TransportState =
  | { readonly kind: 'connecting'; readonly attempt: number }
  | { readonly kind: 'open' }
  | {
      readonly kind: 'closed';
      readonly reason: CloseReason;
      /** How long until the next attempt, when one is scheduled. */
      readonly retryInMs?: number;
      /** What went wrong, when something did. */
      readonly error?: Error;
    };

/**
 * A byte pipe to the robot. It pushes what arrives and never has to be polled.
 *
 * Bytes carry no framing of their own: a chunk can hold part of a frame, one frame or several.
 */
export interface Transport {
  /** Where the transport is now. */
  readonly state: TransportState;

  /** Start connecting, and keep reconnecting when the connection drops, until `close()`. */
  open(): void;

  /**
   * Send bytes to the robot. Bytes sent while the transport is not open are dropped and reported
   * as an error, because nothing sent before a handshake means anything after one.
   */
  send(bytes: Uint8Array): void;

  /** Call a listener with every chunk of bytes that arrives. */
  onBytes(listener: Listener<Uint8Array>): Unsubscribe;

  /** Call a listener every time the state changes. */
  onState(listener: Listener<TransportState>): Unsubscribe;

  /** Call a listener with every error that did not by itself close the transport. */
  onError(listener: Listener<Error>): Unsubscribe;

  /** Disconnect, stop reconnecting and drop whatever was queued. */
  close(): void;
}

interface TransportEvents {
  bytes: Uint8Array;
  state: TransportState;
  error: Error;
}

/**
 * The listener bookkeeping every transport shares, so that each one only implements how it
 * connects, sends and receives.
 */
export abstract class BaseTransport implements Transport {
  private readonly events = new Emitter<TransportEvents>();
  private current: TransportState = { kind: 'closed', reason: 'not-opened' };

  get state(): TransportState {
    return this.current;
  }

  abstract open(): void;

  abstract send(bytes: Uint8Array): void;

  abstract close(): void;

  onBytes(listener: Listener<Uint8Array>): Unsubscribe {
    return this.events.on('bytes', listener);
  }

  onState(listener: Listener<TransportState>): Unsubscribe {
    return this.events.on('state', listener);
  }

  onError(listener: Listener<Error>): Unsubscribe {
    return this.events.on('error', listener);
  }

  /** Move to a new state and tell the listeners. */
  protected setState(state: TransportState): void {
    this.current = state;
    this.events.emit('state', state);
  }

  /** Hand bytes that arrived to the listeners. */
  protected receive(bytes: Uint8Array): void {
    this.events.emit('bytes', bytes);
  }

  /** Report an error that did not close the transport. */
  protected reportError(error: Error): void {
    this.events.emit('error', error);
  }

  /** Report bytes sent while the transport could not take them. */
  protected reportNotOpen(bytes: Uint8Array): void {
    this.reportError(new Error(`Dropped ${bytes.length} bytes sent while ${this.current.kind}`));
  }
}
