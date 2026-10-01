/**
 * The monitor's log: what the robot logged and what the connection noted, kept to a bound.
 *
 * @module
 */

/** How serious a log entry is. */
export type LogSeverity = 'debug' | 'info' | 'warning' | 'error';

/** One line of the log. */
export interface LogEntry {
  /** When the robot logged it, on the session timeline, for robot entries whose time is known. */
  readonly timeUs?: number;
  /** When the monitor got it, in `Date.now()` milliseconds. */
  readonly hostTime: number;
  readonly severity: LogSeverity;
  /** Whether the robot sent it or the connection noted it. */
  readonly source: 'robot' | 'link';
  readonly text: string;
}

/** How many entries a log keeps unless told otherwise. */
export const DEFAULT_LOG_LIMIT = 1000;

/** The newest entries of a log, oldest first, as an array that is replaced on every change. */
export class BoundedLog {
  readonly #limit: number;
  #entries: readonly LogEntry[] = [];

  /**
   * @param limit How many entries to keep.
   */
  constructor(limit = DEFAULT_LOG_LIMIT) {
    this.#limit = Math.max(1, Math.floor(limit));
  }

  /** Every entry kept, oldest first; the same array until an entry arrives. */
  get entries(): readonly LogEntry[] {
    return this.#entries;
  }

  /** Adds an entry, letting go of the oldest one when the log is full. */
  add(entry: LogEntry): void {
    const kept = this.#entries.length < this.#limit ? this.#entries : this.#entries.slice(1);
    this.#entries = [...kept, entry];
  }
}
