import type { ErrorCode, WireValue, Severity, WriteStatus } from '../wire';
import type { Epoch, EpochEndReason, SampleValue } from './epochs';
import type { SchemaEntry } from './schema';

/** Why the link is starting a handshake. */
export type HandshakeReason =
  /** The transport just opened. */
  | 'connected'
  /** Groups were enabled but no sample arrived for too long, such as after credit was lost. */
  | 'stall'
  /** The robot went silent, not even answering PING. */
  | 'keepalive'
  /** Schema pages stopped arriving, which resets the credit window they were lost from. */
  | 'schema-retry'
  /**
   * A PONG gave a total of bytes sent that the credit cannot be brought in line with, such as one
   * below what already arrived; a robot that started over sends one, but so may a count gone wrong.
   */
  | 'credit-resync';

/**
 * Where the link is. It goes `disconnected → handshaking → loadingSchema → configuring →
 * streaming`, skipping the schema when it is already known and the configuration when no group
 * is asked for, and goes back to `handshaking` to recover from a stall or a silent robot. It keeps
 * sending HELLO for as long as the transport is open; `error` is only for what retrying cannot
 * fix, such as a robot that speaks another protocol version.
 */
export type LinkState =
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
  /** The credit window the robot starts every handshake with. */
  readonly creditWindow: number;
  /** The same for every handshake with one boot of the robot, and different after a reboot. */
  readonly bootId: number;
  /** The name the robot introduces itself with. */
  readonly robotName: string;
}

/** A schema the link can use. */
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
  /** Samples of the epoch that went missing just before this one. */
  readonly missingBefore: number;
}

/** An epoch that ended, and why. */
export interface EpochEndEvent {
  readonly epoch: Epoch;
  readonly reason: EpochEndReason;
}

/** A new run of the robot's clock, which the times of later epochs belong to. */
export interface TimelineEvent {
  readonly id: number;
  /** The first contact, a reset seen in the timestamps, or a new boot id in the handshake. */
  readonly reason: 'connected' | 'clock-reset' | 'reboot';
}

/** Samples the robot took but that never arrived. */
export interface DroppedEvent {
  readonly epoch: number;
  readonly count: number;
}

/** What a READ returns: a primitive, or the bytes of a blob. */
export type ReadResult = WireValue | Uint8Array;

/** The answer to a READ. */
export interface ValueEvent {
  readonly variableId: number;
  readonly value: ReadResult;
}

/**
 * The life of a write. A value is only ever `confirmed` once the robot acknowledged it, and one
 * replaced by a newer write before it was sent is `superseded`.
 */
export type WriteEvent =
  | { readonly variableId: number; readonly value: WireValue; readonly state: 'pending' }
  | { readonly variableId: number; readonly value: WireValue; readonly state: 'superseded' }
  | { readonly variableId: number; readonly value: WireValue; readonly state: 'confirmed' }
  | {
      readonly variableId: number;
      readonly value: WireValue;
      readonly state: 'refused';
      readonly status: WriteStatus;
    }
  | {
      readonly variableId: number;
      readonly value: WireValue;
      readonly state: 'failed';
      readonly error: Error;
    };

/** A message the robot logged. */
export interface LogEvent {
  readonly severity: Severity;
  readonly text: string;
  /** When, in microseconds on the time of the samples. */
  readonly timeUs: number;
}

/** How a `setGroups` ended: applied, or replaced by a later call first. */
export type GroupsResult =
  | { readonly status: 'applied'; readonly epochs: readonly Epoch[] }
  | { readonly status: 'superseded' };

/** How a write ended: answered by the robot, or replaced by a newer write before it was sent. */
export type WriteResult =
  | { readonly status: 'answered'; readonly writeStatus: WriteStatus }
  | { readonly status: 'superseded' };

/** Something on the link did not follow the protocol. */
export interface ProtocolErrorEvent {
  readonly message: string;
  /** The code of an ERROR the robot sent that no request was waiting for. */
  readonly code?: ErrorCode;
  readonly context?: number;
}

/** Counters of the link since it was created. */
export interface LinkCounters {
  readonly bytesIn: number;
  readonly bytesOut: number;
  /** Frames that passed the frame check. */
  readonly framesIn: number;
  /** Frames thrown away for failing the frame check, a bad encoding or a run too long for a frame. */
  readonly framesDiscarded: number;
  /** Frames that passed the check but could not be read as the message their type names. */
  readonly framesUndecodable: number;
  /** Bytes of credit given back to the robot. */
  readonly creditReturned: number;
  /** Bytes of credit given back for metered frames that were lost, as a PONG revealed. */
  readonly creditRecovered: number;
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

/** Every event a link emits, by name. */
export interface LinkEvents {
  state: LinkState;
  schema: SchemaReady;
  epoch: Epoch;
  epochEnd: EpochEndEvent;
  timeline: TimelineEvent;
  sample: SampleEvent;
  dropped: DroppedEvent;
  value: ValueEvent;
  write: WriteEvent;
  log: LogEvent;
  protocolError: ProtocolErrorEvent;
  stats: LinkCounters;
}

/** Every timeout and period of a link, in milliseconds unless named otherwise. */
export interface LinkTiming {
  /** How long to wait for the first HELLO_ACK before sending HELLO again. */
  helloTimeoutMs: number;
  /** The longest wait between two HELLOs, which the wait grows to as HELLOs go unanswered. */
  helloBackoffMaxMs: number;
  /** How long schema pages may stop arriving before the handshake is redone. */
  schemaTimeoutMs: number;
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
export const DEFAULT_TIMING: LinkTiming = {
  helloTimeoutMs: 1000,
  helloBackoffMaxMs: 5000,
  schemaTimeoutMs: 1500,
  requestTimeoutMs: 1000,
  groupAttempts: 3,
  pingIntervalMs: 1000,
  silenceTimeoutMs: 3000,
  stallPeriods: 20,
  minStallMs: 1000,
  statsIntervalMs: 1000,
};
