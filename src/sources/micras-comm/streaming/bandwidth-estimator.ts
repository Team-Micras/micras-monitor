import type { LinkCounters } from '../link/link-events';

/** What the UART between the robot and its radio carries at 115200 baud, 8N1. */
export const UART_BYTES_PER_SECOND = 11_520;

/** How a {@link BandwidthEstimator} estimates what the link carries. */
export interface BandwidthEstimatorOptions {
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
  /**
   * How much a run of drops that outlasts a cut cuts the ceiling again, as a factor of what the
   * link was taken to carry; drops that follow a cut closely are taken as from before it.
   */
  backoff: number;
  /**
   * The share of the samples taken, from 0 to 1, that has to be lost in an update before the
   * link counts as full; a lone loss on a busy link is noise, not a full link.
   */
  dropShare: number;
  /**
   * How many samples one frame discarded as corrupt may account for when only gaps in the
   * sequence tell what was lost, since a corrupted delimiter can take two frames with it.
   */
  lossPerDiscard: number;
  /** The lowest the budget goes, in bytes per second. */
  floorBytesPerSecond: number;
  /** How much of each new measurement the smoothed rates take, from 0 to 1. */
  smoothing: number;
}

/** A radio link's defaults: a round trip of 100 ms until measured, and 15 % of headroom. */
export const DEFAULT_BANDWIDTH_ESTIMATOR: BandwidthEstimatorOptions = {
  capBytesPerSecond: UART_BYTES_PER_SECOND,
  headroom: 0.85,
  assumedRttMs: 100,
  holdMs: 10_000,
  probeGrowth: 1.1,
  quietHolds: 6,
  backoff: 0.8,
  dropShare: 0.01,
  lossPerDiscard: 2,
  floorBytesPerSecond: 200,
  smoothing: 0.5,
};

/** How many steps back toward the target may fail before it is given up for slow probes. */
const MAX_FAILED_STEPS = 4;

/** What a {@link BandwidthEstimator} made of the link's counters. */
export interface BudgetEstimate {
  /** The bytes per second samples may take. */
  readonly bytesPerSecond: number;
  /** What the link seems to carry in all, before headroom and unmetered traffic. */
  readonly capacityBytesPerSecond: number;
  /** Bytes per second that arrived, smoothed. */
  readonly bytesInPerSecond: number;
  /** Whether samples dropped for want of room on the link since the last update. */
  readonly saturated: boolean;
  /** Grows every time the ceiling moves, so a planner knows to plan again. */
  readonly revision: number;
}

/** The robot's own count of samples it dropped, as streamed. */
export interface DropCounter {
  /** The samples it dropped since it booted. */
  readonly count: number;
  /** How often the count is streamed, in milliseconds, which is how late it can be. */
  readonly periodMs: number;
}

interface Sample {
  readonly at: number;
  readonly stats: LinkCounters;
  readonly dropped: number | undefined;
}

/**
 * Estimates the bytes per second a link carries from its counters.
 *
 * The credit bounds the link at one window per round trip, and the robot's UART bounds it
 * again. Neither says what the radio carries, nor how long the monitor may take to give credit
 * back: that only shows when samples drop because the robot ran out of credit. The robot's own
 * count of dropped samples says so when it is known; otherwise gaps in the sequence beyond what
 * corrupted frames explain do.
 *
 * Samples count as dropped for want of room only past a small share of those taken, and, from
 * gaps alone, past what corrupted frames explain. The first drops put a ceiling at what arrived,
 * below what the UART and the ceiling before let the link carry, and the capacity before them,
 * when the link had held it clean for a hold period, is kept as a target. Drops that outlast the cut, once the robot had time to get the plan made for
 * it and to report its count again, cut it again by the backoff, so a link that drops for a
 * reason the counters do not show, such as a monitor that stalls, is backed off from until it
 * stops. A saturated link never raises the ceiling. The credit's own bound is taken again with
 * every update, from the round trip of the moment, and never kept in the ceiling, so a round
 * trip a stall inflated is forgotten with the stall.
 *
 * A ceiling that ran a hold period without drops is safe. While the plan wants more, it is then
 * raised: halfway back to the target while there is one, so a link that recovers from a stall
 * gets back to what it carried within a few holds, and otherwise by one probe over the most that
 * arrived. A raise that makes samples drop puts the ceiling back to the last safe one. A step
 * toward the target is then tried again after twice the wait, until one holds, and the target is
 * given up after a few; a probe stops probing for a quiet period that doubles with every failed probe, so on a
 * stable link the estimate settles and drops all but stop. A hold that passes with nothing more
 * wanted forgets the failed probes. A cut below the last safe ceiling, as when the link got
 * worse, lets probing start again from there, so the link is found again when it recovers.
 * Traffic the credit does not meter is taken off what samples may use.
 */
export class BandwidthEstimator {
  readonly #options: BandwidthEstimatorOptions;
  #last: Sample | undefined;
  #bytesIn = 0;
  #arrivedMax = 0;
  #cleanSince: number | undefined;
  #unmetered = 0;
  #ceiling = Number.POSITIVE_INFINITY;
  #ceilingAt = Number.NEGATIVE_INFINITY;
  #safe: number | undefined;
  #probeFrom: number | undefined;
  #probing = true;
  #failedProbes = 0;
  #target: number | undefined;
  #failedSteps = 0;
  #recoverUntil = Number.NEGATIVE_INFINITY;
  #revision = 0;
  #current: BudgetEstimate;

  /**
   * @param options What to change from {@link DEFAULT_BANDWIDTH_ESTIMATOR}.
   */
  constructor(options: Partial<BandwidthEstimatorOptions> = {}) {
    this.#options = { ...DEFAULT_BANDWIDTH_ESTIMATOR, ...options };
    this.#current = this.#estimate(null, 0, false);
  }

  /** The estimate of the last update. */
  get value(): BudgetEstimate {
    return this.#current;
  }

  /**
   * Take the counters of the link.
   *
   * @param stats The link's counters.
   * @param creditWindow The robot's credit window, in bytes.
   * @param now The current time, in milliseconds.
   * @param wantsMore Whether the plan was cut to fit, which lets a safe ceiling be probed.
   * @param dropCounter The robot's own count of samples it dropped, when it is streamed.
   * @returns The new estimate.
   */
  update(
    stats: LinkCounters,
    creditWindow: number,
    now: number,
    wantsMore: boolean,
    dropCounter?: DropCounter
  ): BudgetEstimate {
    const previous = this.#last;
    this.#last = { at: now, stats, dropped: dropCounter?.count };

    if (!previous || now <= previous.at || stats.bytesIn < previous.stats.bytesIn) {
      this.#current = this.#estimate(stats.rttMs, creditWindow, false);
      return this.#current;
    }

    const seconds = (now - previous.at) / 1000;
    const arrived = (stats.bytesIn - previous.stats.bytesIn) / seconds;
    const metered = (stats.creditReturned - previous.stats.creditReturned) / seconds;
    const saturated = this.#saturatedSince(previous, stats, dropCounter?.count);

    this.#bytesIn = this.#smooth(this.#bytesIn, arrived);
    this.#unmetered = this.#smooth(this.#unmetered, Math.max(0, arrived - metered));
    this.#arrivedMax = Math.max(this.#arrivedMax, arrived);

    if (saturated) {
      const rtt = stats.rttMs ?? this.#options.assumedRttMs;
      const lateMs = now - previous.at + (dropCounter?.periodMs ?? 0) + 2 * rtt;
      this.#onSaturated(arrived, now, lateMs);
    } else if (now - this.#ceilingAt >= this.#options.holdMs && Number.isFinite(this.#ceiling)) {
      this.#onHeld(wantsMore, now);
    }

    this.#cleanSince = saturated ? undefined : (this.#cleanSince ?? previous.at);
    this.#current = this.#estimate(stats.rttMs, creditWindow, saturated);
    return this.#current;
  }

  #saturatedSince(previous: Sample, stats: LinkCounters, dropped: number | undefined): boolean {
    const { dropShare, lossPerDiscard } = this.#options;
    const lost =
      dropped !== undefined && previous.dropped !== undefined
        ? dropped - previous.dropped
        : stats.droppedSamples -
          previous.stats.droppedSamples -
          lossPerDiscard * (stats.framesDiscarded - previous.stats.framesDiscarded);
    const taken = stats.samples - previous.stats.samples + Math.max(0, lost);

    return lost > 0 && lost > dropShare * taken;
  }

  #onSaturated(arrived: number, now: number, lateMs: number): void {
    const { capBytesPerSecond, floorBytesPerSecond, backoff } = this.#options;

    if (this.#probeFrom !== undefined) {
      this.#cut(this.#probeFrom, now, lateMs);
      this.#probeFrom = undefined;

      if (this.#target === undefined) {
        this.#probing = false;
        this.#failedProbes++;
      } else if (++this.#failedSteps >= MAX_FAILED_STEPS) {
        this.#target = undefined;
      }

      return;
    }

    if (now < this.#recoverUntil) {
      this.#ceilingAt = now;
      return;
    }

    const carried = Math.min(capBytesPerSecond, this.#ceiling);
    const ceiling = Math.max(floorBytesPerSecond, Math.min(arrived, carried * backoff));
    if (this.#target === undefined) {
      this.#failedSteps = 0;
    }

    this.#target ??= this.#heldClean(now) ? this.#current.capacityBytesPerSecond : undefined;

    if (this.#safe !== undefined && ceiling < this.#safe) {
      this.#safe = ceiling;
      this.#probing = true;
    }

    this.#cut(ceiling, now, lateMs);
  }

  #cut(ceiling: number, now: number, lateMs: number): void {
    this.#recoverUntil = now + lateMs;
    this.#setCeiling(Math.min(this.#ceiling, ceiling), now);
  }

  #onHeld(wantsMore: boolean, now: number): void {
    const { holdMs, quietHolds, probeGrowth } = this.#options;
    const quietMs = holdMs * quietHolds * 2 ** Math.max(0, this.#failedProbes - 1);

    if (!this.#probing && now - this.#ceilingAt >= quietMs) {
      this.#probing = true;
    }

    if (this.#probeFrom !== undefined) {
      this.#failedSteps = 0;
    }

    if (this.#probeFrom !== undefined || this.#safe === undefined) {
      this.#safe = this.#ceiling;
      this.#probeFrom = undefined;
    }

    if (!wantsMore) {
      this.#failedProbes = 0;
      return;
    }

    if (this.#target !== undefined && this.#target > this.#ceiling) {
      if (now - this.#ceilingAt >= holdMs * 2 ** this.#failedSteps) {
        this.#probeFrom = this.#ceiling;
        this.#setCeiling(this.#towardTarget(this.#target), now);
      }
    } else if (this.#probing) {
      this.#target = undefined;
      this.#probeFrom = this.#ceiling;
      this.#setCeiling(Math.max(this.#ceiling, this.#arrivedMax) * probeGrowth, now);
    }
  }

  /** Whether the link ran a hold period without drops until now. */
  #heldClean(now: number): boolean {
    return this.#cleanSince !== undefined && now - this.#cleanSince >= this.#options.holdMs;
  }

  /** Halfway from the ceiling to the target, or the target itself once that is close. */
  #towardTarget(target: number): number {
    const halfway = (this.#ceiling + target) / 2;

    if (target - halfway > target * (this.#options.probeGrowth - 1)) {
      return halfway;
    }

    this.#target = undefined;
    this.#failedProbes = 0;
    this.#failedSteps = 0;
    return target;
  }

  #setCeiling(ceiling: number, now: number): void {
    this.#ceilingAt = now;
    this.#arrivedMax = 0;

    if (ceiling !== this.#ceiling) {
      this.#ceiling = ceiling;
      this.#revision++;
    }
  }

  #smooth(previous: number, next: number): number {
    return previous + this.#options.smoothing * (next - previous);
  }

  #capacity(rttMs: number | null, creditWindow: number): number {
    const { capBytesPerSecond, assumedRttMs } = this.#options;
    const rtt = rttMs !== null && rttMs > 0 ? rttMs : assumedRttMs;
    const credit = creditWindow > 0 ? (creditWindow * 1000) / rtt : capBytesPerSecond;
    return Math.min(capBytesPerSecond, credit, this.#ceiling);
  }

  #estimate(rttMs: number | null, creditWindow: number, saturated: boolean): BudgetEstimate {
    const { headroom, floorBytesPerSecond } = this.#options;
    const capacity = this.#capacity(rttMs, creditWindow);

    return {
      bytesPerSecond: Math.max(floorBytesPerSecond, capacity * headroom - this.#unmetered),
      capacityBytesPerSecond: capacity,
      bytesInPerSecond: this.#bytesIn,
      saturated,
      revision: this.#revision,
    };
  }
}
