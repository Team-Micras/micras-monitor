import { expect, test } from 'vitest';

import type { Scheduler } from '@/telemetry';

import { percentile, reportBench } from '@tests/support/app/bench';
import { PLOTS, renderEightPlots } from '@tests/support/app/eight-plots';

const RUN_MS = 5000;
const WARM_UP_MS = 1000;
const FRAME_BUDGET_MS = 8;

test('eight live plots of 1 kHz signals draw in a few milliseconds a frame', async (context) => {
  const work: number[] = [];
  const intervals: number[] = [];
  const scheduler: Scheduler = {
    schedule: (task) =>
      requestAnimationFrame(() => {
        const started = performance.now();
        task();
        work.push(performance.now() - started);
      }),
  };
  const monitor = await renderEightPlots(scheduler);
  await new Promise((resolve) => setTimeout(resolve, WARM_UP_MS));
  work.length = 0;

  await new Promise<void>((resolve) => {
    let last = performance.now();
    const until = last + RUN_MS;
    const frame = (now: number) => {
      intervals.push(now - last);
      last = now;

      if (now < until) {
        requestAnimationFrame(frame);
      } else {
        resolve();
      }
    };
    requestAnimationFrame(frame);
  });
  monitor.disconnect();

  const fps =
    (1000 * intervals.length) / intervals.reduce((total, interval) => total + interval, 0);
  const summary = `${PLOTS} plots × 2 signals at 1 kHz: work p50 ${percentile(work, 0.5).toFixed(2)} ms, p95 ${percentile(work, 0.95).toFixed(2)} ms, max ${Math.max(...work).toFixed(2)} ms over ${work.length} frames; ${fps.toFixed(0)} fps, frame interval p95 ${percentile(intervals, 0.95).toFixed(1)} ms`;
  await reportBench(context, {
    timings: { frameP95Ms: percentile(work, 0.95) },
    budgets: { frameP95Ms: FRAME_BUDGET_MS },
    summary,
  });

  expect(work.length).toBeGreaterThan(RUN_MS / 50);
});
