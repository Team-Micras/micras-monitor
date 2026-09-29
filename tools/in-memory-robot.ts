/**
 * A simulated robot reached through sockets that live in memory, with no server and no port.
 *
 * Every byte crosses on a timer, as it would cross a real socket on a later turn of the event loop,
 * so a test can put the robot, its radio and the monitor on fake timers together and run minutes
 * of a slow link in virtual time, whatever else loads the machine.
 *
 * @module
 */

import type { WebSocketFactory, WebSocketLike } from '../src/link';
import type { WebSocketEventType } from '../src/link/websocket-transport';
import { emptyRobotStats, NO_FAULTS, type RobotStats } from './simulated-robot/faults';
import type { Robot } from './simulated-robot/robot';
import {
  runRobot,
  type RobotConnection,
  type SimulatedRobotOptions,
} from './simulated-robot/server';

const NORMAL_CLOSURE = 1000;
const ABNORMAL_CLOSURE = 1006;

/** A simulated robot the monitor connects to in memory. */
export interface InMemoryRobot {
  /** What it did, over every connection. */
  readonly stats: RobotStats;

  /** The robot on the latest connection, if one is open. */
  readonly robot: Robot | undefined;

  /** Opens a socket to a robot of its own, fresh from boot, whatever the URL. */
  readonly createSocket: WebSocketFactory;

  /** Drops every connection, as a server that stops does. */
  close(): void;
}

/**
 * Start a simulated robot that monitors reach through `createSocket`.
 *
 * @param options What to change from a link with nothing wrong with it.
 * @returns The robot, ready for connections.
 */
export function startInMemoryRobot(
  options: Partial<Omit<SimulatedRobotOptions, 'port'>> = {}
): InMemoryRobot {
  const settings: SimulatedRobotOptions = {
    ...NO_FAULTS,
    port: 0,
    log: () => undefined,
    ...options,
  };
  const stats = emptyRobotStats();
  const sockets = new Set<InMemorySocket>();
  let latest: Robot | undefined;

  return {
    stats,
    get robot() {
      return latest;
    },
    createSocket: () => {
      const socket = new InMemorySocket((connection) => {
        const robot = runRobot(connection, settings, stats);
        latest = robot;
        connection.onClose(() => {
          sockets.delete(socket);

          if (latest === robot) {
            latest = undefined;
          }
        });
      });
      sockets.add(socket);
      return socket;
    },
    close: () => {
      for (const socket of sockets) {
        socket.drop(ABNORMAL_CLOSURE);
      }
    },
  };
}

/** The monitor's end of an in-memory connection, with the robot's end inside it. */
class InMemorySocket implements WebSocketLike {
  binaryType = 'arraybuffer';
  readonly #listeners = new Map<WebSocketEventType, Set<(event: unknown) => void>>();
  readonly #toRobot = new Set<(bytes: Uint8Array) => void>();
  readonly #onClose = new Set<() => void>();
  #closed = false;

  constructor(accept: (connection: RobotConnection) => void) {
    later(() => {
      if (this.#closed) {
        return;
      }

      accept({
        send: (bytes) => this.#deliver(bytes),
        onMessage: (listener) => this.#toRobot.add(listener),
        onClose: (listener) => this.#onClose.add(listener),
      });
      this.#emit('open', {});
    });
  }

  addEventListener(type: WebSocketEventType, listener: (event: unknown) => void): void {
    const listeners = this.#listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(type, listeners);
  }

  removeEventListener(type: WebSocketEventType, listener: (event: unknown) => void): void {
    this.#listeners.get(type)?.delete(listener);
  }

  send(data: Uint8Array): void {
    if (this.#closed) {
      return;
    }

    const bytes = data.slice();
    later(() => {
      if (!this.#closed) {
        this.#toRobot.forEach((listener) => listener(bytes));
      }
    });
  }

  close(code = NORMAL_CLOSURE): void {
    this.drop(code);
  }

  /** Closes both ends, telling the robot and then the monitor. */
  drop(code: number): void {
    if (this.#closed) {
      return;
    }

    this.#closed = true;
    later(() => {
      this.#onClose.forEach((listener) => listener());
      this.#emit('close', { code, reason: '' });
    });
  }

  #deliver(data: Uint8Array): void {
    if (this.#closed) {
      return;
    }

    const bytes = data.slice();
    later(() => {
      if (!this.#closed) {
        this.#emit('message', { data: bytes.buffer });
      }
    });
  }

  #emit(type: WebSocketEventType, event: unknown): void {
    [...(this.#listeners.get(type) ?? [])].forEach((listener) => listener(event));
  }
}

function later(task: () => void): void {
  setTimeout(task, 0);
}
