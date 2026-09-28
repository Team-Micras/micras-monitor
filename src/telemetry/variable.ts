import type { TypeCode } from '@/protocol';

import type { Epoch } from './epoch';
import { Channel } from './notifier';
import type { LatestValue, TelemetryValue } from './types';

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
 * Everything the store knows about one variable.
 */
export class VariableRecord {
  /** Grows on every change readers could see. */
  readonly channel = new Channel();

  /** The epochs it was part of, in the order they opened. */
  readonly segments: Segment[] = [];

  /** Its type, once an epoch named it. */
  type: TypeCode | undefined;

  /** Whether a 64 bit integer it held did not fit a float exactly. */
  precisionLost = false;

  private latestValue: TelemetryValue | undefined;
  private latestTimeUs: number | undefined;
  private latestSnapshot: LatestValue | undefined;
  private recent: readonly LatestValue[] = [];

  /**
   * @param id The variable's id in the schema.
   * @param historyLength How many values to keep for variables that are not stored numerically.
   */
  constructor(
    readonly id: number,
    private readonly historyLength: number
  ) {}

  /** Whether it is stored numerically in its latest epoch. */
  get numeric(): boolean {
    const last = this.segments.at(-1);
    return last !== undefined && last.column >= 0;
  }

  /**
   * The latest value; the same object until the value changes.
   */
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

  /**
   * Record a new value.
   *
   * @param value The value as decoded.
   * @param timeUs When it was sampled, if known.
   * @param keep Whether it also goes into the short history.
   */
  update(value: TelemetryValue, timeUs: number | undefined, keep: boolean): void {
    this.latestValue = value;
    this.latestTimeUs = timeUs;
    this.latestSnapshot = undefined;

    if (keep) {
      const start = Math.max(0, this.recent.length + 1 - this.historyLength);
      this.recent = [...this.recent.slice(start), { value, timeUs }];
    }
  }
}
