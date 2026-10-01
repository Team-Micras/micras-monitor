import { once } from 'node:events';

import { type WebSocket, WebSocketServer } from 'ws';

import { emptyRobotStats, NO_FAULTS, type FaultOptions, type RobotStats } from './faults';
import { LOOP_TIME_US, Robot } from './robot';
import { Wire } from './wire';

/** How to run a simulated robot. */
export interface SimulatedRobotOptions extends FaultOptions {
  /** The port to listen on; 0 picks a free one. */
  port: number;

  /** Where to report connections, writes and commands; nowhere by default. */
  log: (message: string) => void;
}

/** A simulated robot listening for monitors. */
export interface SimulatedRobot {
  /** The port it listens on. */
  readonly port: number;

  /** What it did, over every connection. */
  readonly stats: RobotStats;

  /** The robot on the latest connection, if one is open. */
  readonly robot: Robot | undefined;

  /** Stop listening and drop every connection. */
  close(): Promise<void>;
}

/**
 * One batch of loop iterations per millisecond stands in for the 8 kHz loop, which is fast enough
 * for the application to see and slow enough for a socket.
 */
const BATCH_INTERVAL_MS = 1;
const TICKS_PER_BATCH = (BATCH_INTERVAL_MS * 1000) / LOOP_TIME_US;

/**
 * Start a simulated robot on a WebSocket, as the simulation's bridge exposes a real one.
 *
 * Each connection gets a robot of its own, fresh from boot.
 *
 * @param options What to change from the defaults: port 8080 and a link with nothing wrong.
 * @returns The running robot, once it is listening.
 */
export async function startSimulatedRobot(
  options: Partial<SimulatedRobotOptions> = {}
): Promise<SimulatedRobot> {
  const settings: SimulatedRobotOptions = {
    ...NO_FAULTS,
    port: 8080,
    log: () => undefined,
    ...options,
  };
  const stats = emptyRobotStats();
  const server = new WebSocketServer({ port: settings.port });
  let latest: Robot | undefined;

  server.on('connection', (socket) => {
    latest = runRobot(overWebSocket(socket), settings, stats);
    socket.on('close', () => {
      latest = undefined;
    });
  });

  await once(server, 'listening');

  const address = server.address();

  return {
    port: typeof address === 'object' && address !== null ? address.port : settings.port,
    stats,
    get robot() {
      return latest;
    },
    close: () => closeServer(server),
  };
}

/** One end of a connection to a monitor, as the robot sees it. */
export interface RobotConnection {
  /** Hand bytes to the monitor. */
  send(bytes: Uint8Array): void;

  /** Be told about the bytes the monitor sends. */
  onMessage(listener: (bytes: Uint8Array) => void): void;

  /** Be told once the connection closes. */
  onClose(listener: () => void): void;
}

/**
 * Run a robot, fresh from boot, over a connection until it closes.
 *
 * @param connection The connection to the monitor.
 * @param settings The link and its faults.
 * @param stats Where to count what the robot does.
 * @returns The robot.
 */
export function runRobot(
  connection: RobotConnection,
  settings: SimulatedRobotOptions,
  stats: RobotStats
): Robot {
  settings.log('application connected');

  const wire = new Wire(
    settings,
    stats,
    (bytes) => connection.send(bytes),
    (bytes) => robot.receive(bytes)
  );
  const robot = new Robot(wire, settings, stats, settings.log);
  const timer = setInterval(() => {
    wire.flush();

    for (let i = 0; i < TICKS_PER_BATCH; i++) {
      robot.tick();
    }
  }, BATCH_INTERVAL_MS);
  const reboot =
    settings.rebootAfterSeconds === null
      ? undefined
      : setTimeout(() => robot.reboot(), settings.rebootAfterSeconds * 1000);

  connection.onMessage((bytes) => wire.receive(bytes));
  connection.onClose(() => {
    settings.log('application disconnected');
    clearInterval(timer);
    clearTimeout(reboot);
  });

  return robot;
}

function overWebSocket(socket: WebSocket): RobotConnection {
  return {
    send: (bytes) => socket.send(bytes),
    onMessage: (listener) => socket.on('message', (data: Buffer) => listener(new Uint8Array(data))),
    onClose: (listener) => socket.on('close', listener),
  };
}

async function closeServer(server: WebSocketServer): Promise<void> {
  for (const client of server.clients) {
    client.terminate();
  }

  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
