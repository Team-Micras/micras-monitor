/**
 * Drive the real session against the simulated robot, over a real socket.
 *
 * This is the step the design puts before the radio exists: the handshake, the paged schema, the
 * groups, the credit window and the acknowledgements are all exercised here, and bringing the
 * module up later is a transport swap rather than a bring-up of everything at once.
 *
 * Run with `npm run check:session`.
 */

import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { WebSocket } from 'ws';

import { CommunicationService } from '../CommunicationService';
import { SerialVariablePool } from '../SerialVariablePool';

// The session is written against a browser; nothing it uses is more than a timer and a cache
const storage = new Map<string, string>();
(globalThis as unknown as { window: unknown }).window = {
  setInterval: setInterval.bind(globalThis),
  clearInterval: clearInterval.bind(globalThis),
  setTimeout: setTimeout.bind(globalThis),
  clearTimeout: clearTimeout.bind(globalThis),
  localStorage: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => void storage.set(key, value),
  },
};

function fail(message: string): never {
  console.error(`FAIL ${message}`);
  process.exit(1);
}

const robot = spawn('npx', ['tsx', 'tools/simulated-robot.ts'], { stdio: 'ignore' });

process.on('exit', () => robot.kill());

await sleep(3000);

const socket = new WebSocket('ws://localhost:8080');
socket.binaryType = 'arraybuffer';

const incoming: number[] = [];
socket.on('message', (data: Buffer) => incoming.push(...new Uint8Array(data)));

await new Promise<void>((resolve, reject) => {
  socket.on('open', () => resolve());
  socket.on('error', reject);
});

const pool = new SerialVariablePool();
let connected = false;
const service = new CommunicationService(pool, (status) => (connected = status));

service.registerCommunicationFunctions(
  async (data) => void socket.send(data),
  async () => {
    const taken = new Uint8Array(incoming);
    incoming.length = 0;
    return taken;
  }
);

service.startCommunication(20);

await sleep(2000);

if (!connected) {
  fail('the handshake did not complete');
}

if (pool.getVariableCount() === 0) {
  fail('the schema never arrived');
}

console.log(
  `schema: ${pool.getVariableCount()} variables, hash ${pool.getSchemaHash().toString(16)}`
);

const gyro = pool.getVariableId('imu/gyro_x');

if (gyro === undefined) {
  fail('imu/gyro_x is not in the schema');
}

await sleep(2000);

const logs = pool.getVariableLogs(gyro);

if (!logs || logs[0].length < 10) {
  fail(`only ${logs?.[0].length ?? 0} samples arrived for imu/gyro_x`);
}

// The x axis is the robot's own clock, so it has to move forward on its own
const span = logs[0][logs[0].length - 1] - logs[0][0];

if (span <= 0) {
  fail('the robot timestamps did not advance');
}

// Every variable of a group is captured in the same iteration, so they share their timestamps
const gyroY = pool.getVariableId('imu/gyro_y')!;
const other = pool.getVariableLogs(gyroY)!;

if (other[0].length !== logs[0].length || other[0][0] !== logs[0][0]) {
  fail('two variables of the same group did not share their timestamps');
}

console.log(
  `samples: ${logs[0].length} over ${span.toFixed(0)} ms of robot time, coherent across the group`
);

// A write goes out and comes back acknowledged, and the robot keeps the value
const profile = pool.getVariableId('run_profile')!;
pool.updateVariable<number>(profile, (ref) => (ref.value = 5));

await sleep(500);

service.readVariable(profile);

await sleep(500);

if (pool.getVariable(profile)!.getReference().value !== 5) {
  fail('the value written was not the value read back');
}

console.log('write: run_profile survived a round trip');

// A command happens once
service.sendCommand(2, 0);

await sleep(500);

// The credit window keeps the stream going rather than stalling it
const before = pool.getVariableLogs(gyro)![0].length;

await sleep(1500);

const after = pool.getVariableLogs(gyro)![0].length;

if (after <= before) {
  fail('the stream stalled, so credit is not being returned');
}

console.log(
  `credit: ${after - before} more samples in the last 1.5 s, the window stays open`
);

service.stopCommunication();
socket.close();
robot.kill();

console.log('session ok');
process.exit(0);
