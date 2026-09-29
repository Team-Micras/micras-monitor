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
  #firstUs = Number.POSITIVE_INFINITY;

  constructor(history: HistoryPort, name: string) {
    this.#history = history;
    this.#name = name;
  }

  /**
   * Scans the samples that arrived since the last scan. A history that lost its end or gained a
   * start before the one it had, as after a reset of the store, is scanned again from the start.
   *
   * @returns The transitions, oldest first; the same array until one is added or they restart.
   */
  update(): readonly Transition[] {
    const range = this.#history.timeRange(this.#name);

    if (range === undefined || range.endUs < this.#scannedUs || range.startUs < this.#firstUs) {
      this.#restart();
    }

    if (range === undefined) {
      return this.#transitions;
    }

    this.#firstUs = range.startUs;
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

  #restart(): void {
    if (this.#transitions.length > 0) {
      this.#transitions = [];
    }

    this.#lastValue = undefined;
    this.#scannedUs = Number.NEGATIVE_INFINITY;
    this.#firstUs = Number.POSITIVE_INFINITY;
  }
}
