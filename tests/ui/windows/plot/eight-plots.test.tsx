import { afterEach, expect, test } from 'vitest';

import type { AppMonitor } from '@/ui/monitor-context';
import { PLOTS, RATE_HZ, renderEightPlots, storedSamples } from '@tests/support/ui/eight-plots';

const RUN_MS = 1000;

let monitor: AppMonitor | undefined;

afterEach(() => {
  monitor?.disconnect();
  monitor = undefined;
});

test('eight live plots of 1 kHz signals all draw, and the store keeps their samples', async () => {
  monitor = await renderEightPlots();
  const live = monitor;
  await expect.poll(() => document.querySelectorAll('[data-plot] canvas').length).toBe(PLOTS);

  const before = storedSamples(live);
  const started = performance.now();
  await new Promise((resolve) => setTimeout(resolve, RUN_MS));
  const due = ((performance.now() - started) * RATE_HZ) / 1000;

  expect(storedSamples(live) - before).toBeGreaterThanOrEqual(0.9 * due);
});
