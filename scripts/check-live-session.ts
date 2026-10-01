/**
 * Connect a session to a live robot over WebSocket, such as the simulation's monitor bridge,
 * stream a few variables for a while and print what the link did.
 *
 * ```
 * bun run check:live --url ws://localhost:8080 [--seconds 5] [--period 80]
 *   [--variables name,name,...]
 * ```
 *
 * Without `--variables` it streams the first six streamable numeric variables of the schema.
 * It exits non-zero when the session never streams or no sample arrives.
 *
 * @module
 */

import { parseArgs } from 'node:util';

import { TypeCode } from '../src/protocol';
import {
  Session,
  WebSocketTransport,
  type Epoch,
  type HandshakeReason,
  type LinkStats,
  type SchemaEntry,
} from '../src/link';

const { values: args } = parseArgs({
  options: {
    url: { type: 'string', default: 'ws://localhost:8080' },
    seconds: { type: 'string', default: '5' },
    period: { type: 'string', default: '80' },
    variables: { type: 'string' },
  },
});

const seconds = Number(args.seconds);
const periodTicks = Number(args.period);

function pickVariables(schema: readonly SchemaEntry[]): SchemaEntry[] {
  if (args.variables) {
    return args.variables.split(',').map((name) => {
      const entry = schema.find((candidate) => candidate.name === name);

      if (!entry) {
        throw new Error(`The robot has no variable named ${name}`);
      }

      return entry;
    });
  }

  return schema.filter((entry) => entry.access.stream && entry.type !== TypeCode.BLOB).slice(0, 6);
}

function waitUntil(condition: () => boolean, timeoutMs: number, what: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const timer = setInterval(() => {
      if (condition()) {
        clearInterval(timer);
        resolve();
      } else if (performance.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error(`Timed out waiting for ${what}`));
      }
    }, 20);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function describeStats(stats: LinkStats, elapsed: number): string {
  return [
    `in ${stats.bytesIn} B (${Math.round(stats.bytesIn / elapsed)} B/s)`,
    `out ${stats.bytesOut} B`,
    `frames ${stats.framesIn}`,
    `discarded ${stats.framesDiscarded}`,
    `credit ${stats.creditReturned} B`,
    `samples ${stats.samples}`,
    `dropped ${stats.droppedSamples}`,
    `rtt ${stats.rttMs === null ? '-' : `${stats.rttMs.toFixed(1)} ms`}`,
  ].join(', ');
}

const session = new Session(new WebSocketTransport(args.url));
const reasons: HandshakeReason[] = [];
const samplesPerEpoch = new Map<number, number>();
const lastValues = new Map<number, readonly (number | bigint)[]>();
let firstSampleUs: number | undefined;
let lastSampleUs: number | undefined;

session.on('state', (state) => {
  if (state.kind === 'handshaking' && state.attempt === 1) {
    reasons.push(state.reason);
  }

  if (state.kind === 'error') {
    console.error(`session error: ${state.error.message}`);
  }
});
session.on('sample', (sample) => {
  samplesPerEpoch.set(sample.epoch, (samplesPerEpoch.get(sample.epoch) ?? 0) + 1);
  lastValues.set(sample.epoch, sample.values);
  firstSampleUs ??= sample.timeUs;
  lastSampleUs = sample.timeUs;
});
session.on('protocolError', (error) => console.warn(`protocol error: ${error.message}`));
session.on('log', (log) => console.log(`robot log [${log.severity}]: ${log.text}`));

console.log(`connecting to ${args.url}`);
session.open();

try {
  await waitUntil(() => session.state.kind === 'streaming', 15_000, 'the session to stream');

  const schema = session.schema ?? [];
  const robot = session.robot;
  console.log(
    `robot: protocol ${robot?.protocolVersion}, ${schema.length} variables, schema ${robot?.schemaHash.toString(16)}, loop ${robot?.loopTimeUs} us, credit ${robot?.creditWindow} B, ${robot?.robotName} boot ${robot?.bootId.toString(16)}`
  );

  const chosen = pickVariables(schema);
  const result = await session.setGroups([
    { variableIds: chosen.map((entry) => entry.id), periodTicks },
  ]);
  const epochs: readonly Epoch[] = result.status === 'applied' ? result.epochs : [];
  const periodMs = (periodTicks * (robot?.loopTimeUs ?? 0)) / 1000;
  console.log(
    `streaming ${chosen.map((entry) => entry.name).join(', ')} every ${periodTicks} ticks (${periodMs} ms robot time), epoch ${epochs.map((epoch) => epoch.id).join(', ')}, ${epochs[0]?.sampleSize} B per sample`
  );

  const started = performance.now();
  const statsBefore = session.stats;

  const progress = setInterval(() => {
    const elapsed = (performance.now() - started) / 1000;
    console.log(`  t=${elapsed.toFixed(0)}s ${describeStats(session.stats, elapsed)}`);
  }, 1000);
  await sleep(seconds * 1000 + 50);
  clearInterval(progress);

  const elapsed = (performance.now() - started) / 1000;
  const stats = session.stats;
  const robotSeconds =
    firstSampleUs !== undefined && lastSampleUs !== undefined
      ? (lastSampleUs - firstSampleUs) / 1e6
      : 0;
  const read = await session.read(chosen[0].id);

  console.log('summary:');
  console.log(`  ${describeStats(stats, elapsed)}`);
  console.log(
    `  streamed ${stats.samples - statsBefore.samples} samples in ${elapsed.toFixed(2)} s wall, ${robotSeconds.toFixed(2)} s robot time (${(robotSeconds / elapsed).toFixed(2)}x real time)`
  );
  console.log(
    `  sample rate ${((stats.samples - statsBefore.samples) / elapsed).toFixed(1)}/s wall, dropped ${stats.droppedSamples}, credit returned ${stats.creditReturned} B for ${stats.bytesIn} B in`
  );
  console.log(`  handshakes: ${reasons.join(' → ')}; clock resets ${stats.clockResets}`);
  console.log(
    `  last values: ${chosen.map((entry, index) => `${entry.name}=${String(lastValues.get(epochs[0].id)?.[index])}`).join(', ')}`
  );
  console.log(`  READ ${chosen[0].name} = ${String(read)}`);

  session.close();
  process.exit(stats.samples > 0 ? 0 : 1);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  console.error(`state: ${session.state.kind}; ${describeStats(session.stats, 1)}`);
  session.close();
  process.exit(1);
}
