import { expect, inject, test } from 'vitest';

import { Monitor } from '@/core/monitor';
import type { BandwidthEstimatorOptions } from '@/sources/micras-comm/streaming/bandwidth-estimator';
import type { WebSocketLike } from '@/sources/micras-comm/transports/websocket-transport';
import { MicrasCommSource } from '@/sources/micras-comm/micras-comm-source';
import { HistoryStore } from '@/history';
import { percentile, reportBench } from '@tests/support/ui/bench';

declare module 'vitest' {
  interface ProvidedContext {
    simulatedRobotPort: number;
  }
}

const RUN_MS = 5000;
const WARM_UP_MS = 3000;
const RATE_HZ = 8000;

type EventType = Parameters<WebSocketLike['addEventListener']>[0];

interface Busy {
  ms: number;
}

function timedSocket(url: string, busy: Busy): WebSocketLike {
  const socket = new WebSocket(url);
  const timed = new Map<(event: unknown) => void, (event: unknown) => void>();
  return {
    get binaryType() {
      return socket.binaryType;
    },
    set binaryType(type: string) {
      socket.binaryType = type === 'blob' ? 'blob' : 'arraybuffer';
    },
    addEventListener(type: EventType, listener: (event: unknown) => void) {
      const wrapped = (event: unknown) => {
        const started = performance.now();
        listener(event);
        busy.ms += performance.now() - started;
      };
      timed.set(listener, wrapped);
      socket.addEventListener(type, wrapped);
    },
    removeEventListener(type: EventType, listener: (event: unknown) => void) {
      socket.removeEventListener(type, timed.get(listener) ?? listener);
    },
    send: (data) => socket.send(new Uint8Array(data)),
    close: (code, reason) => socket.close(code, reason),
  };
}

function frames(ms: number, onFrame: () => void): Promise<number> {
  return new Promise((resolve) => {
    const until = performance.now() + ms;
    let count = 0;
    const frame = (now: number) => {
      onFrame();
      count += 1;

      if (now < until) {
        requestAnimationFrame(frame);
      } else {
        resolve(count);
      }
    };
    requestAnimationFrame(frame);
  });
}

function benchLink(link: string, budget: Partial<BandwidthEstimatorOptions>): void {
  test(`the session and the store keep up with every variable at the most ${link} carries`, async (context) => {
    const busy: Busy = { ms: 0 };
    const source = new MicrasCommSource({
      planner: { debounceMs: 20, budget },
      createSocket: (url) => timedSocket(url, busy),
    });
    const monitor = new Monitor({
      history: new HistoryStore({
        scheduler: { schedule: (task) => requestAnimationFrame(() => task()) },
      }),
      source,
    });
    monitor.connect({
      transport: 'websocket',
      url: `ws://127.0.0.1:${inject('simulatedRobotPort')}`,
    });
    await expect
      .poll(() => monitor.state.log.some((entry) => entry.text === 'streaming'))
      .toBe(true);
    const streamed = monitor.state.variables.filter((entry) => entry.access.stream);
    monitor.request(streamed.map((entry) => ({ variable: entry.name, rateHz: RATE_HZ })));
    await frames(WARM_UP_MS, () => undefined);

    const perFrame: number[] = [];
    let last = busy.ms;
    const storedBefore = monitor.history.variable('imu/gyro_z')?.storedSamples ?? 0;
    const started = performance.now();
    await frames(RUN_MS, () => {
      perFrame.push(busy.ms - last);
      last = busy.ms;
    });
    const elapsedMs = performance.now() - started;
    const samplesPerSecond =
      ((monitor.history.variable('imu/gyro_z')?.storedSamples ?? 0) - storedBefore) /
      (elapsedMs / 1000);
    const { bytesInPerSecond } = monitor.state.stats;
    const planned = monitor.state.stats.streams.length;
    monitor.disconnect();

    const share = perFrame.reduce((sum, ms) => sum + ms, 0) / elapsedMs;
    await reportBench(context, {
      timings: { sessionP95Ms: percentile(perFrame, 0.95) },
      summary: `${planned} variables at ${samplesPerSecond.toFixed(0)} samples/s, ${(bytesInPerSecond / 1024).toFixed(1)} KB/s in: session and store p50 ${percentile(perFrame, 0.5).toFixed(2)} ms, p95 ${percentile(perFrame, 0.95).toFixed(2)} ms, max ${Math.max(...perFrame).toFixed(2)} ms per frame over ${perFrame.length} frames, ${(100 * share).toFixed(1)} % of the main thread`,
    });

    expect(samplesPerSecond).toBeGreaterThan(20);
  });
}

benchLink('the robot’s UART', {});
benchLink('a 50 KB/s socket', { capBytesPerSecond: 50_000 });
benchLink('an unbounded local socket', { capBytesPerSecond: Number.POSITIVE_INFINITY });
