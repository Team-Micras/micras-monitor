/**
 * How the telemetry store holds up at the sizes the plan sets for it.
 *
 * 1. A synthetic hour at 150 samples/s of 16 variables, the Micras over BLE: memory, which must
 *    stay under 100 MB.
 * 2. 600k points per signal for 32 signals, the chart benchmark's history: whole-history
 *    decimation at 1,600 px, which must take no more than 2 ms per signal, then 60 s pans and the
 *    10 s live window.
 *
 * Run with `bun run bench:telemetry`; it exits with 1 if a target is missed.
 */

import { TypeCode } from '../src/protocol';
import { Decimation, ManualScheduler, TelemetryStore, type VariableSpec } from '../src/telemetry';

const MB = 1024 * 1024;
const PIXELS = 1600;

function variables(first: number, count: number): VariableSpec[] {
  return Array.from({ length: count }, (_, index) => ({ id: first + index, type: TypeCode.F32 }));
}

function fill(
  store: TelemetryStore,
  epochId: number,
  count: number,
  rateHz: number,
  signals: number,
  seed: number
): void {
  const row = new Float64Array(signals);
  const periodUs = 1e6 / rateHz;

  for (let index = 0; index < count; index++) {
    const t = index / rateHz;

    for (let signal = 0; signal < signals; signal++) {
      const phase = 2 * Math.PI * (0.3 + 0.37 * signal + 0.11 * seed) * t + signal;
      row[signal] = Math.sin(phase) + 0.25 * Math.sin(11 * phase) + 0.02 * ((index * 7919) % 13);
    }

    store.append(epochId, index & 0xffff, index * periodUs, row);
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

function report(name: string, times: number[]): void {
  const mean = times.reduce((sum, time) => sum + time, 0) / times.length;
  console.log(
    `  ${name.padEnd(34)} mean ${mean.toFixed(3)} ms · p50 ${percentile(times, 0.5).toFixed(3)} ms · p95 ${percentile(times, 0.95).toFixed(3)} ms`
  );
}

function syntheticHour(): number {
  const rateHz = 150;
  const count = rateHz * 3600;
  const heapBefore = process.memoryUsage();
  const store = new TelemetryStore({ scheduler: new ManualScheduler() });
  store.openEpoch({ epochId: 1, groupId: 0, variables: variables(0, 16) });
  const start = performance.now();
  fill(store, 1, count, rateHz, 16, 1);
  const elapsed = performance.now() - start;
  const heapAfter = process.memoryUsage();
  const used = store.status().usedBytes / MB;

  console.log('Synthetic hour: 150 samples/s × 16 variables');
  console.log(`  samples per variable             ${count.toLocaleString('en')}`);
  console.log(`  ingestion                        ${elapsed.toFixed(0)} ms`);
  console.log(`  store memory (blocks + pyramid)  ${used.toFixed(1)} MB`);
  console.log(
    `  process resident set, growth     ${((heapAfter.rss - heapBefore.rss) / MB).toFixed(1)} MB`
  );
  console.log(`  target                           ≤ 100 MB: ${used <= 100 ? 'met' : 'MISSED'}`);
  return used;
}

function longHistory(): number {
  const rateHz = 1000;
  const count = 600_000;
  const store = new TelemetryStore({ scheduler: new ManualScheduler() });
  store.openEpoch({ epochId: 1, groupId: 0, variables: variables(0, 16) });
  store.openEpoch({ epochId: 2, groupId: 1, variables: variables(16, 16) });
  const start = performance.now();
  fill(store, 1, count, rateHz, 16, 2);
  fill(store, 2, count, rateHz, 16, 3);
  const ingestion = performance.now() - start;
  const endUs = (count - 1) * (1e6 / rateHz) + 1;
  const decimation = new Decimation();
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

  timeEach(3 * signals, (run) =>
    store.decimate(run % signals, 0, endUs, PIXELS, { into: decimation })
  );
  const whole = timeEach(20 * signals, (run) =>
    store.decimate(run % signals, 0, endUs, PIXELS, { into: decimation })
  );
  const pan = timeEach(20 * signals, (run) => {
    const startUs = random() * (endUs - 60e6);
    store.decimate(run % signals, startUs, startUs + 60e6, PIXELS, { into: decimation });
  });
  const live = timeEach(20 * signals, (run) =>
    store.decimate(run % signals, endUs - 10e6, endUs, PIXELS, { into: decimation })
  );
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
  report('whole history (pyramid)', whole);
  report('pan, 60 s window', pan);
  report('live, last 10 s', live);
  report('whole history, raw rescan baseline', rescan);
  const mean = whole.reduce((sum, time) => sum + time, 0) / whole.length;
  console.log(
    `  target                           ≤ 2 ms per signal: ${mean <= 2 ? 'met' : 'MISSED'}`
  );
  return mean;
}

const hourMegabytes = syntheticHour();
const wholeHistoryMs = longHistory();

if (hourMegabytes > 100 || wholeHistoryMs > 2) {
  process.exitCode = 1;
}
