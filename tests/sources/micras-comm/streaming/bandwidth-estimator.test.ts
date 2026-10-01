import { describe, expect, test } from 'vitest';

import {
  DEFAULT_BANDWIDTH_ESTIMATOR,
  BandwidthEstimator,
  UART_BYTES_PER_SECOND,
} from '@/sources/micras-comm/streaming/bandwidth-estimator';
import type { LinkCounters } from '@/sources/micras-comm/link/link-events';

const BASE: LinkCounters = {
  bytesIn: 0,
  bytesOut: 0,
  framesIn: 0,
  framesDiscarded: 0,
  framesUndecodable: 0,
  creditReturned: 0,
  creditRecovered: 0,
  rttMs: null,
  samples: 0,
  droppedSamples: 0,
  handshakes: 1,
  clockResets: 0,
};

const WINDOW = 256;
const HEADROOM = DEFAULT_BANDWIDTH_ESTIMATOR.headroom;

class Feed {
  readonly budget = new BandwidthEstimator({ smoothing: 1 });
  stats = BASE;
  now = 0;
  robotDropped: number | undefined;
  counterPeriodMs = 1000;

  /** One second of a link that carries `rate` and is asked for `asked`, probing when cut. */
  link(capacity: number, asked: number, seconds: number) {
    for (let second = 0; second < seconds; second++) {
      const planned = Math.min(asked, this.budget.value.bytesPerSecond);
      const arrived = Math.min(planned, capacity);
      this.second(
        {
          bytesIn: arrived,
          creditReturned: arrived,
          droppedSamples: planned > capacity ? 10 : 0,
        },
        asked > this.budget.value.bytesPerSecond
      );
    }
  }

  second(change: Partial<LinkCounters>, wantsMore = false) {
    const { stats } = this;
    this.stats = {
      ...stats,
      bytesIn: stats.bytesIn + (change.bytesIn ?? 0),
      creditReturned: stats.creditReturned + (change.creditReturned ?? 0),
      droppedSamples: stats.droppedSamples + (change.droppedSamples ?? 0),
      samples: stats.samples + (change.samples ?? 0),
      framesDiscarded: stats.framesDiscarded + (change.framesDiscarded ?? 0),
      rttMs: change.rttMs === undefined ? stats.rttMs : change.rttMs,
    };
    this.now += 1000;
    return this.budget.update(
      this.stats,
      WINDOW,
      this.now,
      wantsMore,
      this.robotDropped === undefined
        ? undefined
        : { count: this.robotDropped, periodMs: this.counterPeriodMs }
    );
  }
}

/** The updates, from 1, that cut the ceiling while the robot's counter climbs every second. */
function cutsWith(counterPeriodMs: number): number[] {
  const feed = new Feed();
  feed.counterPeriodMs = counterPeriodMs;
  feed.robotDropped = 0;
  feed.second({ rttMs: 5 });
  const seconds: number[] = [];

  for (let second = 1; second <= 8; second++) {
    feed.robotDropped += 10;
    const before = feed.budget.value.revision;
    const after = feed.second({ bytesIn: 3000, creditReturned: 3000, samples: 50 }).revision;

    if (after !== before) {
      seconds.push(second);
    }
  }

  return seconds;
}

describe('BandwidthEstimator', () => {
  test('assumes a radio round trip until a PING measures one', () => {
    const budget = new BandwidthEstimator();

    expect(budget.update(BASE, WINDOW, 0, false).bytesPerSecond).toBeCloseTo(
      ((WINDOW * 1000) / DEFAULT_BANDWIDTH_ESTIMATOR.assumedRttMs) * HEADROOM
    );
  });

  test('takes one credit window per round trip, capped by the UART', () => {
    const feed = new Feed();

    expect(feed.second({ rttMs: 50 }).capacityBytesPerSecond).toBeCloseTo(5120);
    expect(feed.second({ rttMs: 2 }).capacityBytesPerSecond).toBe(UART_BYTES_PER_SECOND);
  });

  test('takes the traffic the credit does not meter off what samples may use', () => {
    const feed = new Feed();
    feed.second({ rttMs: 50 });
    const estimate = feed.second({ bytesIn: 1200, creditReturned: 1000, rttMs: 50 });

    expect(estimate.bytesPerSecond).toBeCloseTo(5120 * HEADROOM - 200);
  });

  test('caps the link at what arrived when samples drop beyond corrupted frames', () => {
    const feed = new Feed();
    feed.second({ rttMs: 5 });
    const saturated = feed.second({ bytesIn: 3000, creditReturned: 3000, droppedSamples: 40 });

    expect(saturated.saturated).toBe(true);
    expect(saturated.capacityBytesPerSecond).toBeCloseTo(3000);
    expect(saturated.bytesPerSecond).toBeCloseTo(3000 * HEADROOM);
  });

  test('does not take drops that corrupted frames explain for a full link', () => {
    const feed = new Feed();
    feed.second({ rttMs: 5 });
    const estimate = feed.second({
      bytesIn: 3000,
      creditReturned: 3000,
      droppedSamples: 3,
      framesDiscarded: 3,
    });

    expect(estimate.saturated).toBe(false);
    expect(estimate.capacityBytesPerSecond).toBe(UART_BYTES_PER_SECOND);
  });

  test('holds a ceiling, then probes it once per hold period while the plan wants more', () => {
    const feed = new Feed();
    feed.second({ rttMs: 5 });
    feed.second({ bytesIn: 3000, creditReturned: 3000, droppedSamples: 40 });

    for (let second = 0; second < 9; second++) {
      feed.second({ bytesIn: 2500, creditReturned: 2500 }, true);
    }

    expect(feed.budget.value.capacityBytesPerSecond).toBeCloseTo(3000);
    expect(
      feed.second({ bytesIn: 2500, creditReturned: 2500 }, false).capacityBytesPerSecond
    ).toBeCloseTo(3000);
    const probed = feed.second({ bytesIn: 2500, creditReturned: 2500 }, true);
    expect(probed.capacityBytesPerSecond).toBeCloseTo(
      3000 * DEFAULT_BANDWIDTH_ESTIMATOR.probeGrowth
    );
    expect(
      feed.second({ bytesIn: 2500, creditReturned: 2500 }, true).capacityBytesPerSecond
    ).toBeCloseTo(3000 * DEFAULT_BANDWIDTH_ESTIMATOR.probeGrowth);
  });

  test('takes drops right after a cut as from before it, and cuts nothing more', () => {
    const feed = new Feed();
    feed.second({ rttMs: 5 });
    feed.second({ bytesIn: 3000, creditReturned: 3000, droppedSamples: 40 });
    const after = feed.second({ bytesIn: 2400, creditReturned: 2400, droppedSamples: 5 });

    expect(after.capacityBytesPerSecond).toBeCloseTo(3000);
  });

  test('cuts again by the backoff while drops outlast the cut', () => {
    const feed = new Feed();
    feed.second({ rttMs: 5 });
    feed.second({ bytesIn: 3000, creditReturned: 3000, droppedSamples: 40 });
    const ceilings: number[] = [];

    for (let second = 0; second < 6; second++) {
      ceilings.push(
        feed.second({ bytesIn: 2600, creditReturned: 2600, droppedSamples: 5 })
          .capacityBytesPerSecond
      );
    }

    const cut = 3000 * DEFAULT_BANDWIDTH_ESTIMATOR.backoff;
    expect(ceilings[0]).toBeCloseTo(3000);
    expect(ceilings[1]).toBeCloseTo(cut);
    expect(ceilings[2]).toBeCloseTo(cut);
    expect(ceilings[3]).toBeCloseTo(cut * DEFAULT_BANDWIDTH_ESTIMATOR.backoff);
  });

  test('never raises the ceiling while samples drop, whatever arrived', () => {
    const feed = new Feed();
    feed.second({ rttMs: 5 });
    feed.second({ bytesIn: 3000, creditReturned: 3000, droppedSamples: 40 });
    let highest = 0;

    for (let second = 0; second < 12; second++) {
      const dropping = second % 2 === 0;
      const estimate = feed.second({
        bytesIn: 4000,
        creditReturned: 3000,
        droppedSamples: dropping ? 5 : 0,
      });
      highest = Math.max(highest, estimate.capacityBytesPerSecond);
    }

    expect(highest).toBeCloseTo(3000);
    expect(feed.budget.value.capacityBytesPerSecond).toBeLessThan(3000);
  });

  test('backs off from a link the credit bounds, below the bound', () => {
    const feed = new Feed();
    feed.second({ rttMs: 100 });
    const credit = (WINDOW * 1000) / 100;
    const first = feed.second({ bytesIn: 2500, creditReturned: 2500, droppedSamples: 4 });
    feed.second({ bytesIn: 2400, creditReturned: 2400, droppedSamples: 4 });
    feed.second({ bytesIn: 2400, creditReturned: 2400, droppedSamples: 4 });
    const second = feed.second({ bytesIn: 2400, creditReturned: 2400, droppedSamples: 4 });

    expect(first.capacityBytesPerSecond).toBeLessThan(credit);
    expect(second.capacityBytesPerSecond).toBeCloseTo(
      first.capacityBytesPerSecond * DEFAULT_BANDWIDTH_ESTIMATOR.backoff
    );
  });

  test('settles on a stable link: a probe that drops goes back to the last safe ceiling', () => {
    const feed = new Feed();
    feed.second({ rttMs: 5 });
    feed.link(3000, 8000, 120);
    const settled = feed.budget.value;
    const dropped = feed.stats.droppedSamples;
    feed.link(3000, 8000, 50);

    expect(feed.stats.droppedSamples).toBe(dropped);
    expect(feed.budget.value.bytesPerSecond).toBe(settled.bytesPerSecond);
    expect(settled.bytesPerSecond).toBeLessThanOrEqual(3000);
    expect(settled.bytesPerSecond).toBeGreaterThan(3000 * 0.8);
  });

  test('probes again after a long quiet period, waiting twice as long after each failure', () => {
    const feed = new Feed();
    feed.second({ rttMs: 5 });
    feed.link(3000, 8000, 120);
    const dropped = feed.stats.droppedSamples;
    const quietS =
      (DEFAULT_BANDWIDTH_ESTIMATOR.holdMs * DEFAULT_BANDWIDTH_ESTIMATOR.quietHolds) / 1000;
    feed.link(3000, 8000, quietS + 30);
    const afterFirstQuiet = feed.stats.droppedSamples;
    feed.link(3000, 8000, quietS);

    expect(afterFirstQuiet).toBeGreaterThan(dropped);
    expect(feed.stats.droppedSamples).toBe(afterFirstQuiet);
    expect(feed.budget.value.bytesPerSecond).toBeLessThanOrEqual(3000);
  });

  test('finds the link again after a dip pulled the ceiling below the last safe one', () => {
    const feed = new Feed();
    feed.second({ rttMs: 5 });
    feed.link(3000, 8000, 120);
    const settled = feed.budget.value.bytesPerSecond;
    feed.link(1500, 8000, 20);
    const dipped = feed.budget.value.bytesPerSecond;
    feed.link(3000, 8000, 120);

    expect(dipped).toBeLessThan(1500);
    expect(feed.budget.value.bytesPerSecond).toBeGreaterThan(settled * 0.9);
  });

  test('takes a loss below a small share of the samples as noise, not a full link', () => {
    const feed = new Feed();
    feed.second({ rttMs: 5 });
    const busy = feed.second({
      bytesIn: 3000,
      creditReturned: 3000,
      samples: 500,
      droppedSamples: 2,
    });
    const full = feed.second({
      bytesIn: 3000,
      creditReturned: 3000,
      samples: 500,
      droppedSamples: 20,
    });

    expect(busy.saturated).toBe(false);
    expect(full.saturated).toBe(true);
  });

  test('lets two samples go with every frame discarded when only gaps tell', () => {
    const feed = new Feed();
    feed.second({ rttMs: 5 });
    const estimate = feed.second({
      bytesIn: 3000,
      creditReturned: 3000,
      samples: 50,
      droppedSamples: 6,
      framesDiscarded: 3,
    });

    expect(estimate.saturated).toBe(false);
  });

  test('waits for a slow drop counter to report again before it cuts twice', () => {
    expect(cutsWith(1000)).toEqual([1, 4, 7]);
    expect(cutsWith(4000)).toEqual([1, 7]);
  });

  test("takes the robot's own count of dropped samples over gaps seen on the monitor", () => {
    const feed = new Feed();
    feed.robotDropped = 0;
    feed.second({ rttMs: 5 });
    const gaps = feed.second({ bytesIn: 3000, creditReturned: 3000, droppedSamples: 40 });
    feed.robotDropped = 12;
    const counted = feed.second({ bytesIn: 3000, creditReturned: 3000 });

    expect(gaps.saturated).toBe(false);
    expect(counted.saturated).toBe(true);
  });
});
