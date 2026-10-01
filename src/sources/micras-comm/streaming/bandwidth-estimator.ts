import type { LinkStats } from '../link/link-events';

/** What the UART between the robot and its radio carries at 115200 baud, 8N1. */
export const UART_BYTES_PER_SECOND = 11_520;

/** How a {@link LinkBudget} estimates what the link carries. */
export interface LinkBudgetOptions {
  /** The most the link can carry, whatever the credit allows; the robot's UART by default. */
  capBytesPerSecond: number;
  /** The share of the estimate samples may plan for, which leaves room for jitter. */
  headroom: number;
  /** The round trip assumed until a PING measures one, in milliseconds. */
  assumedRttMs: number;
  /**
   * How long, in milliseconds, a ceiling has to run without samples dropping before it is
   * trusted and raised by one probe.
   */
  holdMs: number;
  /** How much one probe raises the ceiling over the most that arrived, as a factor. */
  probeGrowth: number;
  /**
   * How many hold periods the ceiling has to stay put, after a probe made samples drop, before
   * probing starts again; each failed probe doubles it.
   */
  quietHolds: number;
  /** The lowest the budget goes, in bytes per second. */
  floorBytesPerSecond: number;
  /** How much of each new measurement the smoothed rates take, from 0 to 1. */
  smoothing: number;
}

/** A radio link's defaults: a round trip of 100 ms until measured, and 15 % of headroom. */
export const DEFAULT_LINK_BUDGET: LinkBudgetOptions = {
  capBytesPerSecond: UART_BYTES_PER_SECOND,
  headroom: 0.85,
  assumedRttMs: 100,
  holdMs: 10_000,
  probeGrowth: 1.1,
  quietHolds: 6,
  floorBytesPerSecond: 200,
  smoothing: 0.5,
};

/** What a {@link LinkBudget} made of the link's counters. */
export interface BudgetEstimate {
  /** The bytes per second samples may take. */
  readonly bytesPerSecond: number;
  /** What the link seems to carry in all, before headroom and unmetered traffic. */
  readonly capacityBytesPerSecond: number;
  /** Bytes per second that arrived, smoothed. */
  readonly bytesInPerSecond: number;
  /** Bytes per second of frames the credit does not meter, such as VALUE, ACKs and PONG. */
  readonly unmeteredBytesPerSecond: number;
  /** Whether samples dropped for want of room on the link since the last update. */
  readonly saturated: boolean;
  /** Grows every time the ceiling moves, so a planner knows to plan again. */
  readonly revision: number;
}

interface Sample {
  readonly at: number;
  readonly stats: LinkStats;
  readonly robotDropped: number | undefined;
}

/**
 * Estimates the bytes per second a link carries from the session's counters.
 *
 * The credit bounds the link at one window per round trip, and the robot's UART bounds it
 * again. Neither says what the radio carries: that only shows when samples drop because the
 * robot ran out of credit. The robot's own count of dropped samples says so when it is known;
 * otherwise gaps in the sequence beyond what corrupted frames explain do. The most that arrived
 * over a run of such updates becomes a ceiling.
 *
 * A ceiling that ran a hold period without drops is safe. While the plan wants more, it is then
 * raised by one probe, over the most that arrived, and held again. A probe that makes samples
 * drop puts the ceiling back to the last safe one and stops probing for a quiet period that
 * doubles with every failed probe, so on a stable link the estimate settles and drops all but
 * stop. A run of drops that pulls the ceiling below the last safe one, as when the link got
 * worse, lets probing start again from there, so the link is found again when it recovers. Traffic the credit does not meter is taken
 * off what samples may use.
 */
export class LinkBudget {
  private readonly options: LinkBudgetOptions;
  private last: Sample | undefined;
  private bytesIn = 0;
  private arrivedMax = 0;
  private unmetered = 0;
  private ceiling = Number.POSITIVE_INFINITY;
  private ceilingAt = Number.NEGATIVE_INFINITY;
  private safe: number | undefined;
  private probeFrom: number | undefined;
  private probing = true;
  private failedProbes = 0;
  private wasSaturated = false;
  private episodeCapped = false;
  private revision = 0;
  private current: BudgetEstimate;

  /**
   * @param options What to change from {@link DEFAULT_LINK_BUDGET}.
   */
  constructor(options: Partial<LinkBudgetOptions> = {}) {
    this.options = { ...DEFAULT_LINK_BUDGET, ...options };
    this.current = this.estimate(null, 0, false);
  }

  /** The estimate of the last update. */
  get value(): BudgetEstimate {
    return this.current;
  }

  /**
   * Take the counters of the link.
   *
   * @param stats The session's counters.
   * @param creditWindow The robot's credit window, in bytes.
   * @param now The current time, in milliseconds.
   * @param wantsMore Whether the plan was cut to fit, which lets a safe ceiling be probed.
   * @param robotDropped The robot's own count of samples it dropped, when it is streamed.
   * @returns The new estimate.
   */
  update(
    stats: LinkStats,
    creditWindow: number,
    now: number,
    wantsMore: boolean,
    robotDropped?: number
  ): BudgetEstimate {
    const previous = this.last;
    this.last = { at: now, stats, robotDropped };

    if (!previous || now <= previous.at || stats.bytesIn < previous.stats.bytesIn) {
      this.current = this.estimate(stats.rttMs, creditWindow, false);
      return this.current;
    }

    const seconds = (now - previous.at) / 1000;
    const arrived = (stats.bytesIn - previous.stats.bytesIn) / seconds;
    const metered = (stats.creditReturned - previous.stats.creditReturned) / seconds;
    const saturated = this.saturatedSince(previous, stats, robotDropped);

    this.bytesIn = this.smooth(this.bytesIn, arrived);
    this.unmetered = this.smooth(this.unmetered, Math.max(0, arrived - metered));
    this.arrivedMax = Math.max(this.arrivedMax, arrived);

    if (saturated) {
      this.onSaturated(arrived, now);
    } else if (now - this.ceilingAt >= this.options.holdMs && Number.isFinite(this.ceiling)) {
      this.onHeld(wantsMore, now);
    }

    this.wasSaturated = saturated;
    this.current = this.estimate(stats.rttMs, creditWindow, saturated);
    return this.current;
  }

  /** Forget what was measured, as when the link goes to another robot. */
  reset(): void {
    this.last = undefined;
    this.bytesIn = 0;
    this.arrivedMax = 0;
    this.unmetered = 0;
    this.ceiling = Number.POSITIVE_INFINITY;
    this.ceilingAt = Number.NEGATIVE_INFINITY;
    this.safe = undefined;
    this.probeFrom = undefined;
    this.probing = true;
    this.failedProbes = 0;
    this.wasSaturated = false;
    this.episodeCapped = false;
    this.revision++;
    this.current = this.estimate(null, 0, false);
  }

  private saturatedSince(
    previous: Sample,
    stats: LinkStats,
    robotDropped: number | undefined
  ): boolean {
    if (robotDropped !== undefined && previous.robotDropped !== undefined) {
      return robotDropped > previous.robotDropped;
    }

    const dropped = stats.droppedSamples - previous.stats.droppedSamples;
    const discarded = stats.framesDiscarded - previous.stats.framesDiscarded;
    return dropped > discarded;
  }

  private onSaturated(arrived: number, now: number): void {
    const { floorBytesPerSecond } = this.options;

    if (this.probeFrom !== undefined) {
      this.setCeiling(this.probeFrom, now);
      this.probeFrom = undefined;
      this.probing = false;
      this.failedProbes++;
      this.episodeCapped = true;
      return;
    }

    if (this.wasSaturated && this.episodeCapped) {
      this.ceilingAt = now;
      return;
    }

    this.episodeCapped = false;
    const episodeMax = this.wasSaturated ? Math.max(this.ceiling, arrived) : arrived;
    const ceiling = Math.max(floorBytesPerSecond, episodeMax);

    if (this.safe !== undefined && ceiling < this.safe) {
      this.safe = ceiling;
      this.probing = true;
    }

    this.setCeiling(ceiling, now);
  }

  private onHeld(wantsMore: boolean, now: number): void {
    const { holdMs, quietHolds } = this.options;
    const quietMs = holdMs * quietHolds * 2 ** Math.max(0, this.failedProbes - 1);

    if (!this.probing && now - this.ceilingAt >= quietMs) {
      this.probing = true;
    }

    if (this.probeFrom !== undefined || this.safe === undefined) {
      this.safe = this.ceiling;
      this.probeFrom = undefined;
    }

    if (wantsMore && this.probing) {
      this.probeFrom = this.ceiling;
      this.setCeiling(Math.max(this.ceiling, this.arrivedMax) * this.options.probeGrowth, now);
    }
  }

  private setCeiling(ceiling: number, now: number): void {
    this.ceilingAt = now;
    this.arrivedMax = 0;

    if (ceiling !== this.ceiling) {
      this.ceiling = ceiling;
      this.revision++;
    }
  }

  private smooth(previous: number, next: number): number {
    return previous + this.options.smoothing * (next - previous);
  }

  private estimate(rttMs: number | null, creditWindow: number, saturated: boolean): BudgetEstimate {
    const { capBytesPerSecond, headroom, assumedRttMs, floorBytesPerSecond } = this.options;
    const rtt = rttMs !== null && rttMs > 0 ? rttMs : assumedRttMs;
    const credit = creditWindow > 0 ? (creditWindow * 1000) / rtt : capBytesPerSecond;
    const capacity = Math.min(capBytesPerSecond, credit, this.ceiling);

    return {
      bytesPerSecond: Math.max(floorBytesPerSecond, capacity * headroom - this.unmetered),
      capacityBytesPerSecond: capacity,
      bytesInPerSecond: this.bytesIn,
      unmeteredBytesPerSecond: this.unmetered,
      saturated,
      revision: this.revision,
    };
  }
}
