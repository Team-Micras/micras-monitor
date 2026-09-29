import type { LinkStats } from './session-types';

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
  /** How long, in milliseconds, a ceiling found by dropped samples holds before it is probed. */
  holdMs: number;
  /** How much a held ceiling grows per update once it is probed. */
  probeGrowth: number;
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
  probeGrowth: 1.05,
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
  /** Whether samples were seen dropping for want of room on the link since the last update. */
  readonly saturated: boolean;
}

interface Sample {
  readonly at: number;
  readonly stats: LinkStats;
}

/**
 * Estimates the bytes per second a link carries from the session's counters.
 *
 * The credit bounds the link at one window per round trip, and the robot's UART bounds it
 * again. Neither says what the radio carries: that only shows when samples drop because the
 * robot ran out of credit, beyond what corrupted frames explain. Then the rate that did arrive
 * becomes a ceiling, held for a while and then raised a little per update while the plan wants
 * more, so a link that got better is found again. Traffic the credit does not meter is taken off
 * what samples may use.
 */
export class LinkBudget {
  private readonly options: LinkBudgetOptions;
  private last: Sample | undefined;
  private bytesIn = 0;
  private unmetered = 0;
  private ceiling = Number.POSITIVE_INFINITY;
  private ceilingAt = Number.NEGATIVE_INFINITY;
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
   * @param wantsMore Whether the plan was cut to fit, which lets a held ceiling be probed.
   * @returns The new estimate.
   */
  update(stats: LinkStats, creditWindow: number, now: number, wantsMore: boolean): BudgetEstimate {
    const previous = this.last;
    this.last = { at: now, stats };

    if (!previous || now <= previous.at || stats.bytesIn < previous.stats.bytesIn) {
      this.current = this.estimate(stats.rttMs, creditWindow, false);
      return this.current;
    }

    const seconds = (now - previous.at) / 1000;
    const arrived = (stats.bytesIn - previous.stats.bytesIn) / seconds;
    const metered = (stats.creditReturned - previous.stats.creditReturned) / seconds;
    const dropped = stats.droppedSamples - previous.stats.droppedSamples;
    const discarded = stats.framesDiscarded - previous.stats.framesDiscarded;
    const saturated = dropped > discarded;

    this.bytesIn = this.smooth(this.bytesIn, arrived);
    this.unmetered = this.smooth(this.unmetered, Math.max(0, arrived - metered));

    if (saturated) {
      this.ceiling = Math.max(this.options.floorBytesPerSecond, arrived);
      this.ceilingAt = now;
    } else if (
      wantsMore &&
      Number.isFinite(this.ceiling) &&
      now - this.ceilingAt >= this.options.holdMs
    ) {
      this.ceiling *= this.options.probeGrowth;
    }

    this.current = this.estimate(stats.rttMs, creditWindow, saturated);
    return this.current;
  }

  /** Forget what was measured, as when the link goes to another robot. */
  reset(): void {
    this.last = undefined;
    this.bytesIn = 0;
    this.unmetered = 0;
    this.ceiling = Number.POSITIVE_INFINITY;
    this.ceilingAt = Number.NEGATIVE_INFINITY;
    this.current = this.estimate(null, 0, false);
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
    };
  }
}
