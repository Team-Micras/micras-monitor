/**
 * How the history store holds up at the sizes the plan sets for it.
 *
 * 1. A synthetic hour at 150 samples/s of 16 variables, the Micras over BLE: memory, which must
 *    stay under 100 MB, and the whole-history view at 1,600 px while samples keep arriving, which
 *    must take no more than 0.25 ms per signal and frame with each plot's previous result reused.
 * 2. 600k points per signal for 32 signals, the chart benchmark's history: whole-history
 *    decimation from scratch, which must take no more than 2 ms per signal, then 60 s pans and the
 *    10 s live window.
 *
 * Run with `bun run bench:history`; it exits with 1 if a target is missed.
 */

import {
  type Decimation,
  historyWindow,
  HistoryStore,
  type VariableSpec,
  ManualScheduler,
} from '../src/history';

const MB = 1024 * 1024;
const PIXELS = 1600;

function variables(first: number, count: number): VariableSpec[] {
  return Array.from({ length: count }, (_, index) => ({ id: first + index, type: 'f32' }));
}

function fill(
  store: HistoryStore,
  runId: number,
  count: number,
  rateHz: number,
  signals: number,
  seed: number,
  from = 0
): void {
  const row = new Float64Array(signals);
  const periodUs = 1e6 / rateHz;

  for (let index = from; index < from + count; index++) {
    const t = index / rateHz;

    for (let signal = 0; signal < signals; signal++) {
      const phase = 2 * Math.PI * (0.3 + 0.37 * signal + 0.11 * seed) * t + signal;
      row[signal] = Math.sin(phase) + 0.25 * Math.sin(11 * phase) + 0.02 * ((index * 7919) % 13);
    }

    store.append(runId, index * periodUs, row);
  }
}

function percentile(values: number[], share: number): number {
  const sorted = values.toSorted((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(share * sorted.length))];
}

function timeEach(runs: number, query: (run: number) => void): number[] {
  const times: number[] = [];

  for (let run = 0; run < runs; run++) {
    const start = performance.now();
    query(run);
    times.push(performance.now() - start);
  }

  return times;
}

function mean(times: readonly number[]): number {
  return times.reduce((sum, time) => sum + time, 0) / times.length;
}

function report(name: string, times: number[]): void {
  console.log(
    `  ${name.padEnd(34)} mean ${mean(times).toFixed(3)} ms · p50 ${percentile(times, 0.5).toFixed(3)} ms · p95 ${percentile(times, 0.95).toFixed(3)} ms`
  );
}

interface HourResult {
  readonly megabytes: number;
  readonly cachedMs: number;
}

function syntheticHour(): HourResult {
  const rateHz = 150;
  const signals = 16;
  const count = rateHz * 3600;
  const heapBefore = process.memoryUsage();
  const store = new HistoryStore({ scheduler: new ManualScheduler() });
  store.openRun({ runId: 1, slot: 0, variables: variables(0, signals) });
  const start = performance.now();
  fill(store, 1, count, rateHz, signals, 1);
  const elapsed = performance.now() - start;
  const heapAfter = process.memoryUsage();
  const megabytes = store.status().usedBytes / MB;

  console.log(`Synthetic hour: ${rateHz} samples/s × ${signals} variables`);
  console.log(`  samples per variable             ${count.toLocaleString('en')}`);
  console.log(`  ingestion                        ${elapsed.toFixed(0)} ms`);
  console.log(`  store memory (blocks + pyramid)  ${megabytes.toFixed(1)} MB`);
  console.log(
    `  process resident set, growth     ${((heapAfter.rss - heapBefore.rss) / MB).toFixed(1)} MB`
  );
  console.log(
    `  target                           ≤ 100 MB: ${megabytes <= 100 ? 'met' : 'MISSED'}`
  );

  const plots: (Decimation | undefined)[] = Array.from({ length: signals }, () => undefined);
  const view = (signal: number) => {
    const range = store.timeRange(signal);

    if (range) {
      const window = historyWindow(range, PIXELS);
      plots[signal] = store.decimate(signal, window.startUs, window.endUs, PIXELS, {
        into: plots[signal],
      });
    }
  };
  const cold = timeEach(signals, (signal) => view(signal));
  const unchanged = timeEach(20 * signals, (run) => view(run % signals));
  const perFrame = 3;
  const frames = 600;
  let appended = count;
  const frameTimes: number[] = [];

  for (let frame = 0; frame < frames; frame++) {
    fill(store, 1, perFrame, rateHz, signals, 1, appended);
    appended += perFrame;
    const began = performance.now();

    for (let signal = 0; signal < signals; signal++) {
      view(signal);
    }

    frameTimes.push((performance.now() - began) / signals);
  }

  const cachedMs = mean(frameTimes);
  console.log(`  whole history, ${PIXELS} px, per signal:`);
  report('from scratch', cold);
  report('reused, nothing new', unchanged);
  report(`reused, ${perFrame} new samples per frame`, frameTimes);
  console.log(
    `  target                           ≤ 0.25 ms per signal: ${cachedMs <= 0.25 ? 'met' : 'MISSED'}`
  );
  return { megabytes, cachedMs };
}

function longHistory(): number {
  const rateHz = 1000;
  const count = 600_000;
  const store = new HistoryStore({ scheduler: new ManualScheduler() });
  store.openRun({ runId: 1, slot: 0, variables: variables(0, 16) });
  store.openRun({ runId: 2, slot: 1, variables: variables(16, 16) });
  const start = performance.now();
  fill(store, 1, count, rateHz, 16, 2);
  fill(store, 2, count, rateHz, 16, 3);
  const ingestion = performance.now() - start;
  const endUs = (count - 1) * (1e6 / rateHz) + 1;
  let decimation: Decimation | undefined;
  const signals = 32;
  let seed = 7;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };

  console.log('\nLong history: 600k points per signal × 32 signals at 1 kHz');
  console.log(`  ingestion                        ${ingestion.toFixed(0)} ms`);
  console.log(
    `  store memory                     ${(store.status().usedBytes / MB).toFixed(1)} MB`
  );

  const query = (signal: number, startUs: number, stopUs: number) => {
    decimation = store.decimate(signal, startUs, stopUs, PIXELS, { into: decimation });
  };
  timeEach(3 * signals, (run) => query(run % signals, 0, endUs));
  const whole = timeEach(20 * signals, (run) => query(run % signals, 0, endUs));
  const pan = timeEach(20 * signals, (run) => {
    const startUs = random() * (endUs - 60e6);
    query(run % signals, startUs, startUs + 60e6);
  });
  const live = timeEach(20 * signals, (run) => query(run % signals, endUs - 10e6, endUs));
  const rescan = timeEach(4 * signals, (run) => {
    const min = new Float64Array(PIXELS).fill(Number.POSITIVE_INFINITY);
    const max = new Float64Array(PIXELS).fill(Number.NEGATIVE_INFINITY);
    const scale = PIXELS / endUs;

    for (const { time, values } of store.samples(run % signals, 0, endUs)) {
      for (let index = 0; index < time.length; index++) {
        const column = Math.min(PIXELS - 1, Math.floor(time[index] * scale));
        const value = values[index];

        if (value < min[column]) {
          min[column] = value;
        }

        if (value > max[column]) {
          max[column] = value;
        }
      }
    }
  });

  console.log(`  per signal, ${PIXELS} px:`);
  report('whole history from scratch', whole);
  report('pan, 60 s window', pan);
  report('live, last 10 s', live);
  report('whole history, raw rescan baseline', rescan);
  const wholeMs = mean(whole);
  console.log(
    `  target                           ≤ 2 ms per signal: ${wholeMs <= 2 ? 'met' : 'MISSED'}`
  );
  return wholeMs;
}

const hour = syntheticHour();
const wholeHistoryMs = longHistory();

if (hour.megabytes > 100 || hour.cachedMs > 0.25 || wholeHistoryMs > 2) {
  process.exitCode = 1;
}
