/**
 * The boundary between the monitor and where its data comes from. A source, such as a robot over
 * `micras_comm` or the demo robot, implements {@link Source}; the monitor hands each connection a
 * {@link SourceSink} to push what it learns into, and drives it through the
 * {@link SourceConnection} it gets back. Nothing here knows a wire format.
 *
 * @module
 */

import type { LogSeverity } from './log';
import type { Value, Variable } from './variables';

/** The ways a source can reach a robot. */
export type TargetKind = 'websocket' | 'bluetooth';

/** Where to reach a robot. */
export type Target =
  | { readonly transport: 'websocket'; readonly url: string }
  | { readonly transport: 'bluetooth' };

/** What a robot told about itself once it answered. */
export interface SourceIdentity {
  /** The name it gives, or null when it gives none. */
  readonly name: string | null;
  /** What identifies its set of variables, such as the hash of a schema, as people read it. */
  readonly schema: string | null;
}

/**
 * Where a connection is. `connecting` opens the way to the robot and `handshaking` waits for it
 * to answer; `linked` is a robot that said who it is and takes commands; `failed` is a connection
 * that ended with an error the user has to act on.
 */
export type SourceStatus =
  | { readonly kind: 'disconnected' }
  | { readonly kind: 'connecting'; readonly target: Target }
  | { readonly kind: 'handshaking'; readonly target: Target }
  | {
      readonly kind: 'linked';
      readonly target: Target;
      readonly identity: SourceIdentity;
      /** When the robot answered, in `Date.now()` milliseconds. */
      readonly since: number;
    }
  | { readonly kind: 'failed'; readonly target: Target; readonly message: string };

/** A variable the monitor wants streamed, and how often. */
export interface StreamDemand {
  readonly variableId: number;
  /** Samples per second wanted; the source may grant fewer. */
  readonly rateHz: number;
  /**
   * The role the robot package pins the variable by, such as `state`, for a variable streamed
   * whatever is on screen; the source cuts these last and may give some roles a meaning of its own.
   */
  readonly role?: string;
}

/** A stream the source opened: variables the robot samples together, on one run of its clock. */
export interface StreamInfo {
  /** Unique among the streams open on the connection. */
  readonly id: number;
  /** Where the robot keeps the stream; a new stream in a slot replaces the one there. */
  readonly slot: number;
  /** The variables of each sample, in order. */
  readonly variableIds: readonly number[];
  /** The run of the robot's clock the times of its samples are on, as the source numbers them. */
  readonly clock: number;
}

/** Why the history must not draw a line across a moment. */
export type BoundaryKind =
  /** The source lost the robot for a while. */
  | 'reconnect'
  /** The robot's clock started over, as after a reboot. */
  | 'reboot';

/** A line for the monitor's log. */
export interface SourceLog {
  readonly severity: LogSeverity;
  /** Whether the robot logged it or the source noted it about the connection. */
  readonly source: 'robot' | 'link';
  readonly text: string;
  /** For a line the robot logged, when, on a run of its clock, in microseconds. */
  readonly at?: { readonly clock: number; readonly timeUs: number };
}

/** A measure of something with a limit, such as a buffer or a rate. */
export interface Gauge {
  readonly label: string;
  readonly used: number;
  readonly capacity: number;
  /** What `used` and `capacity` count: bytes, or bytes per second. */
  readonly unit: 'B' | 'B/s';
  /** Whether it is past what is healthy. */
  readonly warn: boolean;
}

/** The rate a variable was asked for and the rate the source streams it at. */
export interface StreamRate {
  readonly variableId: number;
  readonly askedHz: number;
  /** Zero when the source left it out. */
  readonly grantedHz: number;
}

/** The counters of a connection, as a snapshot. */
export interface SourceStats {
  /** Bytes received per second, over the last second or so. */
  readonly bytesInPerSecond: number;
  /** The round trip to the robot, in milliseconds; NaN until known. */
  readonly rttMs: number;
  /** Samples the source knows the robot took but that never arrived. */
  readonly samplesDropped: number;
  /** Pieces of data thrown away as malformed. */
  readonly framesDiscarded: number;
  /** Whatever else the source measures against a limit. */
  readonly gauges: readonly Gauge[];
  /** Every variable streamed or asked for. */
  readonly streams: readonly StreamRate[];
}

/** The counters of a connection that has measured nothing. */
export const NO_STATS: SourceStats = {
  bytesInPerSecond: 0,
  rttMs: Number.NaN,
  samplesDropped: 0,
  framesDiscarded: 0,
  gauges: [],
  streams: [],
};

/**
 * How a command ended. The robot's own answers carry a reason code, which the robot package
 * names; `failed` is a command that got no answer, such as with no connection.
 */
export type CommandOutcome =
  | {
      readonly status: 'ok' | 'unknown' | 'refused' | 'deferred';
      readonly reason: number | null;
    }
  | { readonly status: 'failed'; readonly message: string };

/** A value a variable can be written with. */
export type WriteValue = number | boolean | bigint;

/** Why the robot refused a write. */
export type WriteRefusal = 'no-such-variable' | 'read-only' | 'needs-idle' | 'wrong-size';

/**
 * How a write ended: the robot took the value, refused it, a newer write of the same variable
 * replaced it before it was sent, or it got no answer, such as with no connection.
 */
export type WriteOutcome =
  | { readonly status: 'confirmed' }
  | { readonly status: 'refused'; readonly reason: WriteRefusal }
  | { readonly status: 'superseded' }
  | { readonly status: 'failed'; readonly message: string };

/** How a read ended: the value, which also becomes the variable's latest, or why it failed. */
export type ReadOutcome =
  | { readonly status: 'ok'; readonly value: Value }
  | { readonly status: 'failed'; readonly message: string };

/**
 * Where a connection pushes what it learns. Calls made after the connection was closed are
 * ignored.
 */
export interface SourceSink {
  /** The connection's status changed. */
  status(status: SourceStatus): void;
  /** The robot's variables are known, or none are: an empty list. */
  variables(variables: readonly Variable[]): void;
  /** A stream started. */
  streamOpened(stream: StreamInfo): void;
  /** A stream stopped. */
  streamClosed(id: number): void;
  /**
   * One sample of a stream.
   *
   * @param stream The stream's id.
   * @param timeUs When the robot took it, on the stream's clock, in microseconds.
   * @param values One value per variable of the stream, in its order.
   * @param missedBefore How many samples of the stream the source lost just before this one.
   */
  sample(stream: number, timeUs: number, values: readonly Value[], missedBefore: number): void;
  /** A value that did not come in a stream, such as the answer to a read. */
  value(variableId: number, value: Value): void;
  /** Nothing must be drawn across this moment. */
  boundary(kind: BoundaryKind): void;
  /** A line for the log. */
  log(entry: SourceLog): void;
  /** A write started or ended, so the pending writes changed. */
  writesChanged(): void;
  /** The counters changed. */
  stats(stats: SourceStats): void;
}

/** One connection of a source, as the monitor drives it. */
export interface SourceConnection {
  /** Replaces what the monitor wants streamed. */
  request(demands: readonly StreamDemand[]): void;
  /** Sends a command and waits for the robot's answer; never rejects. */
  command(code: number, argument?: number): Promise<CommandOutcome>;
  /** Writes a variable and waits for the robot's answer; never rejects. */
  write(variableId: number, value: WriteValue): Promise<WriteOutcome>;
  /** Asks the robot for a variable's value, which the sink also gets; never rejects. */
  read(variableId: number): Promise<ReadOutcome>;
  /** The newest value written to a variable that the robot has not answered yet. */
  pendingWrite(variableId: number): WriteValue | undefined;
  /** Ends the connection; the sink hears nothing more from it. */
  close(): void;
}

/** Something the monitor can take robot data from: a plugin. */
export interface Source {
  /** What the source is, such as `micras-comm` or `demo`. */
  readonly id: string;
  /** The kinds of target it can reach here. */
  readonly targets: readonly TargetKind[];
  /**
   * Starts a connection. Progress and failure arrive through the sink, from this call on;
   * Bluetooth needs to be called from a user gesture.
   */
  connect(target: Target, sink: SourceSink): SourceConnection;
}
