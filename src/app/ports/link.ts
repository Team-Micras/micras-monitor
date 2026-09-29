/**
 * The ports the Link and Log windows read the session through: counters of the link with the
 * stream planner's budget, and the robot's LOG messages mixed with the link's own events.
 *
 * @module
 */

/** A rate the stream planner chose for one variable. */
export interface PlannedStream {
  /** The variable, by name. */
  readonly variable: string;
  /** Samples per second the windows asked for. */
  readonly rateHz: number;
  /** Samples per second the planner fit into the budget; 0 when it left the variable out. */
  readonly grantedHz: number;
}

/** What the stream planner spends of the link, per second. */
export interface StreamBudget {
  /** The bytes per second the link measurably carries. */
  readonly bytesPerSecond: number;
  /** The bytes per second the planned streams take. */
  readonly used: number;
  /** Whether what the windows ask for does not fit, so some rates were cut. */
  readonly overBudget: boolean;
  /** Every variable streamed or asked for, with its requested and granted rate. */
  readonly planned: readonly PlannedStream[];
}

/** Counters of the link, as a snapshot. */
export interface LinkStats {
  /** Bytes received per second, over the last second or so. */
  readonly bytesInPerSecond: number;
  /** The credit window of the robot, in bytes. */
  readonly creditWindow: number;
  /** The bytes the robot sent that the monitor has not credited back yet. */
  readonly creditOutstanding: number;
  /** Frames discarded as malformed since the session started. */
  readonly framesDiscarded: number;
  /** Samples the sequence numbers show as lost since the session started. */
  readonly samplesDropped: number;
  /** The round trip of the last PING, in milliseconds; NaN until one is answered. */
  readonly rttMs: number;
  /** What the stream planner spends. */
  readonly budget: StreamBudget;
}

/** The counters of the link. */
export interface LinkStatsPort {
  /** The latest counters; the same object until they change. */
  stats(): LinkStats;

  /** Calls `callback` after the counters change; returns the function that stops it. */
  subscribe(callback: () => void): () => void;
}

/** How serious a log entry is, as the robot's LOG severities. */
export type LogSeverity = 'debug' | 'info' | 'warning' | 'error';

/** One line of the log. */
export interface LogEntry {
  /** When the robot logged it, on the session timeline, for robot entries. */
  readonly timeUs?: number;
  /** When the monitor got it, in `Date.now()` milliseconds. */
  readonly hostTime: number;
  readonly severity: LogSeverity;
  /** Whether the robot sent it or the link noted it. */
  readonly source: 'robot' | 'link';
  readonly text: string;
}

/** The robot's LOG messages and the link's events, oldest first. */
export interface LogPort {
  /** Every entry kept, oldest first; the same array until an entry arrives. */
  entries(): readonly LogEntry[];

  /** Calls `callback` after entries arrive; returns the function that stops it. */
  subscribe(callback: () => void): () => void;
}
