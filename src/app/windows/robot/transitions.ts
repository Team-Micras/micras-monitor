/**
 * The changes of a variable's value over its history, such as the state of the robot, found by
 * scanning each new stretch of samples once.
 *
 * @module
 */

import { nextUp } from '@/telemetry';

import type { HistoryPort } from '../../ports';

/** A moment the value changed. */
export interface Transition {
  /** The value from then on. */
  readonly value: number;
  /** When it took the value, on the session timeline. */
  readonly timeUs: number;
}

/** How many transitions a tracker keeps, the newest. */
export const TRANSITION_LIMIT = 64;

/** Finds the transitions of one variable, keeping its place in the history between scans. */
export class TransitionTracker {
  readonly #history: HistoryPort;
  readonly #name: string;
  #transitions: readonly Transition[] = [];
  #lastValue: number | undefined;
  #scannedUs = Number.NEGATIVE_INFINITY;

  constructor(history: HistoryPort, name: string) {
    this.#history = history;
    this.#name = name;
  }

  /**
   * Scans the samples that arrived since the last scan.
   *
   * @returns The transitions, oldest first; the same array until one is added.
   */
  update(): readonly Transition[] {
    const found: Transition[] = [];

    for (const run of this.#history.samples(
      this.#name,
      this.#scannedUs,
      Number.POSITIVE_INFINITY
    )) {
      for (let index = 0; index < run.time.length; index++) {
        const timeUs = run.time[index];

        if (timeUs < this.#scannedUs) {
          continue;
        }

        const value = run.values[index];
        this.#scannedUs = nextUp(timeUs);

        if (Number.isNaN(value) || value === this.#lastValue) {
          continue;
        }

        this.#lastValue = value;
        found.push({ value, timeUs });
      }
    }

    if (found.length > 0) {
      this.#transitions = [...this.#transitions, ...found].slice(-TRANSITION_LIMIT);
    }

    return this.#transitions;
  }
}
