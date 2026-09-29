/**
 * The log of a live link: the robot's LOG messages and what the link noted, kept to a bound.
 *
 * @module
 */

import { Severity } from '@/protocol';

import type { LogEntry, LogPort, LogSeverity } from '../ports';

/** How many entries a log keeps unless told otherwise. */
export const DEFAULT_LOG_LIMIT = 1000;

const SEVERITIES: Readonly<Record<Severity, LogSeverity>> = {
  [Severity.DEBUG]: 'debug',
  [Severity.INFO]: 'info',
  [Severity.WARNING]: 'warning',
  [Severity.ERROR]: 'error',
};

/** The name the log gives a LOG severity; an unknown one reads as info. */
export function logSeverity(severity: Severity): LogSeverity {
  return SEVERITIES[severity] ?? 'info';
}

/** A {@link LogPort} that keeps the newest entries, oldest first. */
export class LiveLog implements LogPort {
  readonly #limit: number;
  readonly #listeners = new Set<() => void>();
  readonly #now: () => number;
  #entries: readonly LogEntry[] = [];

  /**
   * @param limit How many entries to keep.
   * @param now The host's clock, in `Date.now()` milliseconds.
   */
  constructor(limit = DEFAULT_LOG_LIMIT, now: () => number = Date.now) {
    this.#limit = limit;
    this.#now = now;
  }

  /** Every entry kept, oldest first; the same array until an entry arrives. */
  entries(): readonly LogEntry[] {
    return this.#entries;
  }

  /** Calls `callback` after every entry that arrives; returns the function that stops it. */
  subscribe(callback: () => void): () => void {
    this.#listeners.add(callback);
    return () => this.#listeners.delete(callback);
  }

  /** Adds a message the robot logged, at its time on the session timeline when known. */
  robot(severity: LogSeverity, text: string, timeUs: number | undefined): void {
    this.#add(
      timeUs === undefined
        ? { hostTime: this.#now(), severity, source: 'robot', text }
        : { timeUs, hostTime: this.#now(), severity, source: 'robot', text }
    );
  }

  /** Adds something the link noted. */
  link(severity: LogSeverity, text: string): void {
    this.#add({ hostTime: this.#now(), severity, source: 'link', text });
  }

  #add(entry: LogEntry): void {
    const kept = this.#entries.length < this.#limit ? this.#entries : this.#entries.slice(1);
    this.#entries = [...kept, entry];
    [...this.#listeners].forEach((listener) => listener());
  }
}
