import { afterEach, expect, test } from 'vitest';

import type { FakeRobot } from '../../fake/fake-robot';
import { PLOTS, RATE_HZ, renderEightPlots, storedSamples } from '../../fixtures/eight-plots';

const RUN_MS = 1000;

let robot: FakeRobot | undefined;

afterEach(() => {
  robot?.disconnect();
  robot = undefined;
});

test('eight live plots of 1 kHz signals all draw, and the store keeps their samples', async () => {
  robot = await renderEightPlots();
  const live = robot;
  await expect.poll(() => document.querySelectorAll('[data-plot] canvas').length).toBe(PLOTS);

  const before = storedSamples(live);
  const started = performance.now();
  await new Promise((resolve) => setTimeout(resolve, RUN_MS));
  const due = ((performance.now() - started) * RATE_HZ) / 1000;

  expect(storedSamples(live) - before).toBeGreaterThanOrEqual(0.9 * due);
});
