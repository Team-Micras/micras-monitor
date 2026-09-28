import type { TypeCode } from '@/protocol';

import type { Epoch } from './epoch';
import type { Channel } from './notifier';
import type { HistoryMark, LatestValue, TelemetryValue } from './types';

/**
 * A stretch of a variable's history: an epoch it was part of, and its column there.
 */
export interface Segment {
  /** The epoch. */
  readonly epoch: Epoch;

  /** The variable's numeric column in the epoch, or -1 for a blob. */
  readonly column: number;
}

/**
 * The history of one variable under one name and type.
 *
 * A variable that comes back with another type after a reboot gets a new record, so that its old
 * samples keep their meaning; both share the name's channel, so readers subscribed by name hear
 * about either.
 */
export class VariableRecord {
  private static made = 0;

  /** Tells this history apart from any other, for its marks. */
  readonly serial = ++VariableRecord.made;

  /** The epochs it was part of, in the order they opened. */
  readonly segments: Segment[] = [];

  /** Whether a 64 bit integer it held did not fit a float exactly. */
  precisionLost = false;

  /** The time of its last stored sample, or −∞. */
  tailUs = Number.NEGATIVE_INFINITY;

  private latestValue: TelemetryValue | undefined;
  private latestTimeUs: number | undefined;
  private latestSnapshot: LatestValue | undefined;
  private recent: readonly LatestValue[] = [];
  private historyVersion = 0;
  private rewriteVersion = 0;
  private markSnapshot: HistoryMark | undefined;

  /**
   * @param name The variable's name.
   * @param type Its type, if known yet.
   * @param channel The name's change channel.
   * @param historyLength How many values to keep for variables not stored numerically.
   */
  constructor(
    readonly name: string,
    public type: TypeCode | undefined,
    readonly channel: Channel,
    private readonly historyLength: number
  ) {}

  /** Whether it is stored numerically in its latest epoch. */
  get numeric(): boolean {
    const last = this.segments.at(-1);
    return last !== undefined && last.column >= 0;
  }

  /** The latest value; the same object until the value changes. */
  get latest(): LatestValue | undefined {
    if (this.latestValue === undefined) {
      return undefined;
    }

    this.latestSnapshot ??= { value: this.latestValue, timeUs: this.latestTimeUs };
    return this.latestSnapshot;
  }

  /**
   * The last values of a variable that is not stored numerically, oldest first; the same array
   * until a value arrives.
   */
  get history(): readonly LatestValue[] {
    return this.recent;
  }

  /** Where the history stands; the same object until it changes. */
  get mark(): HistoryMark {
    this.markSnapshot ??= {
      source: this.serial,
      version: this.historyVersion,
      rewrite: this.rewriteVersion,
      tailUs: this.tailUs,
    };
    return this.markSnapshot;
  }

  /** Record a new latest value. */
  setLatest(value: TelemetryValue, timeUs: number | undefined): void {
    this.latestValue = value;
    this.latestTimeUs = timeUs;
    this.latestSnapshot = undefined;
  }

  /** Keep a value in the short history of a variable not stored numerically. */
  remember(value: TelemetryValue, timeUs: number | undefined): void {
    const start = Math.max(0, this.recent.length + 1 - this.historyLength);
    this.recent = [...this.recent.slice(start), { value, timeUs }];
  }

  /** The history grew at its end. */
  appended(): void {
    this.historyVersion++;
    this.markSnapshot = undefined;
  }

  /** The history changed somewhere other than its end. */
  rewritten(): void {
    this.historyVersion++;
    this.rewriteVersion++;
    this.markSnapshot = undefined;
  }
}
