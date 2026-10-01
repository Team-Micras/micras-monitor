/**
 * Virtual time for the tests that run the monitor against the simulated robot.
 *
 * The robot, its radio and the monitor all keep time with timers and `performance.now`, so on fake
 * timers they share one clock that nothing else moves. A pump advances that clock in small steps,
 * as fast as the machine allows, and lets the test's own promises settle between steps. A test
 * then waits and sleeps as it would in real time, but a loaded machine only makes it take longer:
 * it cannot make a timeout fire before the bytes it waits for were due.
 *
 * @module
 */

import { afterEach, beforeEach, vi } from 'vitest';

const STEP_MS = 5;

/**
 * Runs every test of the enclosing suite on virtual time. Call it at the top of a `describe`, or
 * of a file, before the hooks that close what the tests open.
 */
export function useVirtualTime(): void {
  let pumping = false;
  let pumped: Promise<void> = Promise.resolve();

  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'],
    });
    pumping = true;
    pumped = pump(() => pumping);
  });

  afterEach(async () => {
    pumping = false;
    await pumped;
    vi.useRealTimers();
  });
}

async function pump(running: () => boolean): Promise<void> {
  while (running()) {
    await vi.advanceTimersByTimeAsync(STEP_MS);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}
