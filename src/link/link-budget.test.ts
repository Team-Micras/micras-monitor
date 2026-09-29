import { describe, expect, test } from 'vitest';

import { DEFAULT_LINK_BUDGET, LinkBudget, UART_BYTES_PER_SECOND } from './link-budget';
import type { LinkStats } from './session-types';

const BASE: LinkStats = {
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
const HEADROOM = DEFAULT_LINK_BUDGET.headroom;

class Feed {
  readonly budget = new LinkBudget({ smoothing: 1 });
  stats = BASE;
  now = 0;
  robotDropped: number | undefined;

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

  second(change: Partial<LinkStats>, wantsMore = false) {
    const { stats } = this;
    this.stats = {
      ...stats,
      bytesIn: stats.bytesIn + (change.bytesIn ?? 0),
      creditReturned: stats.creditReturned + (change.creditReturned ?? 0),
      droppedSamples: stats.droppedSamples + (change.droppedSamples ?? 0),
      framesDiscarded: stats.framesDiscarded + (change.framesDiscarded ?? 0),
      rttMs: change.rttMs === undefined ? stats.rttMs : change.rttMs,
    };
    this.now += 1000;
    return this.budget.update(this.stats, WINDOW, this.now, wantsMore, this.robotDropped);
  }
}

describe('LinkBudget', () => {
  test('assumes a radio round trip until a PING measures one', () => {
    const budget = new LinkBudget();

    expect(budget.update(BASE, WINDOW, 0, false).bytesPerSecond).toBeCloseTo(
      ((WINDOW * 1000) / DEFAULT_LINK_BUDGET.assumedRttMs) * HEADROOM
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

    expect(estimate.unmeteredBytesPerSecond).toBeCloseTo(200);
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
    expect(probed.capacityBytesPerSecond).toBeCloseTo(3000 * DEFAULT_LINK_BUDGET.probeGrowth);
    expect(
      feed.second({ bytesIn: 2500, creditReturned: 2500 }, true).capacityBytesPerSecond
    ).toBeCloseTo(3000 * DEFAULT_LINK_BUDGET.probeGrowth);
  });

  test('keeps the most that arrived over a run of saturated updates', () => {
    const feed = new Feed();
    feed.second({ rttMs: 5 });
    feed.second({ bytesIn: 3000, creditReturned: 3000, droppedSamples: 40 });
    const after = feed.second({ bytesIn: 2400, creditReturned: 2400, droppedSamples: 5 });

    expect(after.capacityBytesPerSecond).toBeCloseTo(3000);
  });

  test('settles on a stable link: a probe that drops goes back to the last safe ceiling', () => {
    const feed = new Feed();
    feed.second({ rttMs: 5 });
    feed.link(3000, 8000, 120);
    const settled = feed.budget.value;
    const dropped = feed.stats.droppedSamples;
    feed.link(3000, 8000, 120);

    expect(feed.stats.droppedSamples).toBe(dropped);
    expect(feed.budget.value.bytesPerSecond).toBe(settled.bytesPerSecond);
    expect(settled.bytesPerSecond).toBeLessThanOrEqual(3000);
    expect(settled.bytesPerSecond).toBeGreaterThan(3000 * 0.8);
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

  test('forgets what it measured on reset', () => {
    const feed = new Feed();
    feed.second({ rttMs: 5 });
    feed.second({ bytesIn: 3000, creditReturned: 3000, droppedSamples: 40 });
    feed.budget.reset();

    expect(feed.budget.value.saturated).toBe(false);
    expect(feed.budget.value.capacityBytesPerSecond).toBe(UART_BYTES_PER_SECOND);
  });
});
