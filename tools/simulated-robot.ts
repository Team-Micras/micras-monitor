/**
 * Run the simulated robot on a WebSocket, so the application can connect to it as it would to the
 * simulation's bridge.
 *
 * `bun run simulate` listens on ws://localhost:8080 (or `MICRAS_SIM_PORT`) over a perfect link.
 * Flags shape the link and inject faults:
 *
 * ```
 * --port <n>                 port to listen on
 * --throughput <bytes/s>     cap what the radio carries
 * --latency <ms>             delay each direction
 * --drop-schema-page <n>     lose schema page n (from 0), once
 * --drop-credits <n>         ignore n CREDIT frames once samples flow
 * --corrupt <rate>           corrupt this share (0 to 1) of outgoing frames
 * --reboot-after <s>         reset the robot once, s seconds after connecting
 * --seed <n>                 seed for which frames get corrupted
 * ```
 *
 * @module
 */

import { parseArgs } from 'node:util';

import { NO_FAULTS, type FaultOptions } from './simulated-robot/faults';
import { startSimulatedRobot, type SimulatedRobotOptions } from './simulated-robot/server';
import { createVariables, schemaHash } from './simulated-robot/variables';

type NumericOption = keyof FaultOptions | 'port';

const FLAGS: readonly (readonly [flag: string, option: NumericOption])[] = [
  ['port', 'port'],
  ['throughput', 'throughputBytesPerSecond'],
  ['latency', 'latencyMs'],
  ['drop-schema-page', 'dropSchemaPage'],
  ['drop-credits', 'dropCredits'],
  ['corrupt', 'corruptRate'],
  ['reboot-after', 'rebootAfterSeconds'],
  ['seed', 'seed'],
];

const DEFAULTS: Record<NumericOption, number | null> = { ...NO_FAULTS, port: 8080 };

function parseOptions(): Partial<SimulatedRobotOptions> {
  const { values } = parseArgs({
    options: Object.fromEntries(FLAGS.map(([flag]) => [flag, { type: 'string' as const }])),
  });
  const options: Partial<Record<NumericOption, number>> = {
    port: Number(process.env.MICRAS_SIM_PORT ?? DEFAULTS.port),
  };

  for (const [flag, option] of FLAGS) {
    const text = values[flag];

    if (typeof text === 'string') {
      options[option] = parseNumber(flag, text);
    }
  }

  return options;
}

function parseNumber(flag: string, text: string): number {
  const value = Number(text);

  if (!Number.isFinite(value) || value < 0) {
    console.error(`--${flag} takes a non-negative number, got ${text}`);
    process.exit(2);
  }

  return value;
}

function describeLink(options: Partial<SimulatedRobotOptions>): string {
  const changed = FLAGS.filter(
    ([, option]) =>
      option !== 'port' && options[option] !== undefined && options[option] !== DEFAULTS[option]
  );

  return changed.length === 0
    ? 'a perfect link'
    : changed.map(([flag, option]) => `--${flag} ${String(options[option])}`).join(' ');
}

const options = parseOptions();
const variables = createVariables();

try {
  const robot = await startSimulatedRobot({ ...options, log: (message) => console.log(message) });
  console.log(
    `simulated robot listening on ws://localhost:${robot.port} over ${describeLink(options)}`
  );
  console.log(`${variables.length} variables, schema hash ${schemaHash(variables).toString(16)}`);
} catch (error) {
  console.error(
    `could not listen on ${options.port}:`,
    error instanceof Error ? error.message : error
  );
  process.exit(1);
}
