import type { Value, ValueType } from '@/core/variables';

import type { StreamRun } from './stream-run';
import type { ChangeSignal } from './tick-notifier';
import type { HistoryMark, LatestValue, TimeRange } from './types';

/**
 * A stretch of a variable's history: a run it was part of, and its column there.
 */
export interface Segment {
  /** The run. */
  readonly run: StreamRun;

  /** The variable's numeric column in the run, or -1 for a blob. */
  readonly column: number;
}

/**
 * The history of one variable under one name and type.
 *
 * A variable that comes back with another type after a reboot gets a new history, so that its
 * old samples keep their meaning; both share the name's channel, so readers subscribed by name
 * hear about either. Every change touches the channel.
 */
export class VariableHistory {
  static #made = 0;

  /** Tells this history apart from any other, for its marks. */
  readonly serial = ++VariableHistory.#made;

  /** The variable's name. */
  readonly name: string;

  /** Its type, once known. */
  type: ValueType | undefined;

  /** The name's change channel. */
  readonly channel: ChangeSignal;

  /** The runs it was part of, in the order they opened. */
  readonly segments: Segment[] = [];

  /** Whether a 64 bit integer it held did not fit a float exactly. */
  precisionLost = false;

  /** The time of its last stored sample, or −∞. */
  tailUs = Number.NEGATIVE_INFINITY;

  /** The id the variable last had, in a run or a value, for the records of a recording. */
  lastId: number | undefined;

  readonly #historyLength: number;
  #latestValue: Value | undefined;
  #latestTimeUs: number | undefined;
  #latest: LatestValue | undefined;
  #recent: readonly LatestValue[] = [];
  #version = 0;
  #rewrite = 0;
  #mark: HistoryMark | undefined;
  #range: { readonly version: number; readonly value: TimeRange | undefined } | undefined;

  /**
   * @param name The variable's name.
   * @param type Its type, if known yet.
   * @param channel The name's change channel.
   * @param historyLength How many values to keep for variables not stored numerically.
   */
  constructor(
    name: string,
    type: ValueType | undefined,
    channel: ChangeSignal,
    historyLength: number
  ) {
    this.name = name;
    this.type = type;
    this.channel = channel;
    this.#historyLength = historyLength;
  }

  /** Whether it is stored numerically in its latest run. */
  get numeric(): boolean {
    const last = this.segments.at(-1);
    return last !== undefined && last.column >= 0;
  }

  /** The latest value; the same object until the value changes. */
  get latest(): LatestValue | undefined {
    if (this.#latestValue === undefined) {
      return undefined;
    }

    this.#latest ??= { value: this.#latestValue, timeUs: this.#latestTimeUs };
    return this.#latest;
  }

  /**
   * The last values of a variable that is not stored numerically, oldest first; the same array
   * until a value arrives.
   */
  get history(): readonly LatestValue[] {
    return this.#recent;
  }

  /** Where the history stands; the same object until it changes. */
  get mark(): HistoryMark {
    this.#mark ??= {
      source: this.serial,
      version: this.#version,
      rewrite: this.#rewrite,
      tailUs: this.tailUs,
    };
    return this.#mark;
  }

  /**
   * The span of the kept history, computed again only once the history changed, so that it is
   * the same object until then.
   *
   * @param compute How to work it out.
   */
  range(compute: () => TimeRange | undefined): TimeRange | undefined {
    if (this.#range?.version !== this.#version) {
      this.#range = { version: this.#version, value: compute() };
    }

    return this.#range.value;
  }

  /** Record a new latest value; {@link changed}, {@link appended} or {@link rewritten} tell. */
  setLatest(value: Value, timeUs: number | undefined): void {
    this.#latestValue = value;
    this.#latestTimeUs = timeUs;
    this.#latest = undefined;
  }

  /** Something a reader sees changed, such as the latest value, but not the stored history. */
  changed(): void {
    this.channel.touch();
  }

  /** Keep a value in the short history of a variable not stored numerically. */
  remember(value: Value, timeUs: number | undefined): void {
    const start = Math.max(0, this.#recent.length + 1 - this.#historyLength);
    this.#recent = [...this.#recent.slice(start), { value, timeUs }];
  }

  /** The history grew at its end. */
  appended(): void {
    this.#version++;
    this.#mark = undefined;
    this.channel.touch();
  }

  /** The history changed somewhere other than its end. */
  rewritten(): void {
    this.#version++;
    this.#rewrite++;
    this.#mark = undefined;
    this.channel.touch();
  }
}
