import type { ErrorCode, Fundamental, Severity, WriteStatus } from '../protocol';
import type { Epoch, SampleValue } from './groups';
import type { SchemaEntry } from './schema';

/** Why the session is starting a handshake. */
export type HandshakeReason =
  /** The transport just opened. */
  | 'connected'
  /** `restart()` was called. */
  | 'restart'
  /** Groups were enabled but no sample arrived for too long, such as after credit was lost. */
  | 'stall'
  /** The robot went silent, not even answering PING. */
  | 'keepalive'
  /** Schema pages stopped arriving, which resets the credit window they were lost from. */
  | 'schema-retry';

/**
 * Where the session is. It goes `disconnected → handshaking → loadingSchema → configuring →
 * streaming`, skipping the schema when it is already known and the configuration when no group
 * is asked for, and goes back to `handshaking` to recover from a stall or a silent robot.
 */
export type SessionState =
  | { readonly kind: 'disconnected' }
  | { readonly kind: 'handshaking'; readonly reason: HandshakeReason; readonly attempt: number }
  | { readonly kind: 'loadingSchema'; readonly received: number; readonly total: number }
  | { readonly kind: 'configuring' }
  | { readonly kind: 'streaming' }
  | { readonly kind: 'error'; readonly error: Error }
  | { readonly kind: 'closed' };

/** What HELLO_ACK told about the robot. */
export interface RobotInfo {
  readonly protocolVersion: number;
  readonly schemaHash: number;
  readonly variableCount: number;
  /** The period of the control loop, which is the unit of a group period. */
  readonly loopTimeUs: number;
  /** The credit window the robot starts every session with. */
  readonly initialCredit: number;
}

/** A schema the session can use. */
export interface SchemaReady {
  readonly hash: number;
  readonly entries: readonly SchemaEntry[];
  /** Whether it came from the cache rather than from the robot. */
  readonly fromCache: boolean;
}

/** One sample of an epoch. */
export interface SampleEvent {
  readonly epoch: number;
  readonly seq: number;
  /** The robot's time in microseconds, unwrapped past the u32 range. */
  readonly timeUs: number;
  /** One value per variable of the epoch, in its order. */
  readonly values: readonly SampleValue[];
}

/** Samples the robot took but that never arrived. */
export interface DroppedEvent {
  readonly epoch: number;
  readonly count: number;
}

/** What a READ returns: a primitive, or the bytes of a blob. */
export type ReadResult = Fundamental | Uint8Array;

/** The answer to a READ. */
export interface ValueEvent {
  readonly variableId: number;
  readonly value: ReadResult;
}

/**
 * The life of a write. A value is only ever `confirmed` once the robot acknowledged it.
 */
export type WriteEvent =
  | { readonly variableId: number; readonly value: Fundamental; readonly state: 'pending' }
  | { readonly variableId: number; readonly value: Fundamental; readonly state: 'confirmed' }
  | {
      readonly variableId: number;
      readonly value: Fundamental;
      readonly state: 'refused';
      readonly status: WriteStatus;
    }
  | {
      readonly variableId: number;
      readonly value: Fundamental;
      readonly state: 'failed';
      readonly error: Error;
    };

/** A message the robot logged. */
export interface LogEvent {
  readonly severity: Severity;
  readonly text: string;
}

/** Something on the link did not follow the protocol. */
export interface ProtocolErrorEvent {
  readonly message: string;
  /** The code of an ERROR the robot sent that no request was waiting for. */
  readonly code?: ErrorCode;
  readonly context?: number;
}

/** Counters of the link since the session was created. */
export interface LinkStats {
  readonly bytesIn: number;
  readonly bytesOut: number;
  /** Frames that passed the frame check. */
  readonly framesIn: number;
  /** Frames thrown away for failing the frame check or being malformed. */
  readonly framesDiscarded: number;
  /** Bytes of credit given back to the robot. */
  readonly creditReturned: number;
  /** The round trip of the last PING, in milliseconds. */
  readonly rttMs: number | null;
  readonly samples: number;
  /** Samples missing from the sequence of their epoch. */
  readonly droppedSamples: number;
  /** HELLOs sent, retries included. */
  readonly handshakes: number;
  /** Times the robot's clock was seen starting over. */
  readonly clockResets: number;
}

/** Every event a session emits, by name. */
export interface SessionEvents {
  state: SessionState;
  schema: SchemaReady;
  epoch: Epoch;
  sample: SampleEvent;
  dropped: DroppedEvent;
  value: ValueEvent;
  write: WriteEvent;
  log: LogEvent;
  protocolError: ProtocolErrorEvent;
  stats: LinkStats;
}

/** Every timeout and period of a session, in milliseconds unless named otherwise. */
export interface SessionTiming {
  /** How long to wait for HELLO_ACK before sending HELLO again. */
  helloTimeoutMs: number;
  /** How many HELLOs to send before giving up. */
  helloAttempts: number;
  /** How long schema pages may stop arriving before the handshake is redone. */
  schemaTimeoutMs: number;
  /** How many times to ask for the schema before giving up. */
  schemaAttempts: number;
  /** How long to wait for the answer to a request. */
  requestTimeoutMs: number;
  /** How many times to send a group request that got no answer. */
  groupAttempts: number;
  /** How often to PING, which is also how long a PING waits for its PONG. */
  pingIntervalMs: number;
  /**
   * How long the robot may send nothing that passes the frame check, PONGs included, before the
   * handshake is redone. A lost PONG alone is not silence.
   */
  silenceTimeoutMs: number;
  /** How many periods of the fastest group may pass without a sample before it is a stall. */
  stallPeriods: number;
  /** The shortest time without samples that counts as a stall. */
  minStallMs: number;
  /** How often to emit the link stats. */
  statsIntervalMs: number;
}

/** Timing for a radio link with a round trip of 50 to 100 ms. */
export const DEFAULT_TIMING: SessionTiming = {
  helloTimeoutMs: 1000,
  helloAttempts: 5,
  schemaTimeoutMs: 1500,
  schemaAttempts: 5,
  requestTimeoutMs: 1000,
  groupAttempts: 3,
  pingIntervalMs: 1000,
  silenceTimeoutMs: 3000,
  stallPeriods: 20,
  minStallMs: 1000,
  statsIntervalMs: 1000,
};
