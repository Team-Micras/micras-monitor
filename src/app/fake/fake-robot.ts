/**
 * An in-memory robot behind the app's ports, for development and tests until the link and the
 * telemetry store are wired in. It goes through the same statuses a session does, streams
 * synthetic values ten times a second and answers commands through a callback.
 *
 * @module
 */

import { TypeCode, type Access } from '@/protocol';

import type {
  CommandOutcome,
  ConnectionStatus,
  ConnectionTarget,
  LiveValue,
  MonitorPorts,
  Transport,
  VariableInfo,
} from '../ports';

/** A variable of the fake robot. */
export interface FakeVariable {
  readonly name: string;
  readonly type: TypeCode;
  readonly access: Access;
  readonly typeTag?: string | null;
  /** Its value at a time in seconds since streaming began; a gentle wave when omitted. */
  readonly signal?: (seconds: number) => number;
}

/** What the fake robot can do while it answers a command. */
export interface FakeRobotControl {
  /** Pins a variable to a value, overriding its signal, until `release`. */
  hold(name: string, value: number): void;
  /** Lets a variable follow its signal again. */
  release(name: string): void;
  /** The current value of a numeric variable. */
  valueOf(name: string): number | undefined;
}

/** How the fake robot behaves. */
export interface FakeRobotOptions {
  /** The name it announces, or null to act as firmware that announces none. */
  readonly name: string | null;
  readonly schemaHash: number;
  readonly variables: readonly FakeVariable[];
  /** Milliseconds to open the transport. */
  readonly connectMs?: number;
  /** Milliseconds from HELLO to streaming. */
  readonly handshakeMs?: number;
  /** Milliseconds between two updates of the values. */
  readonly tickMs?: number;
  /** Milliseconds to answer a command. */
  readonly commandMs?: number;
  /** Whether the Bluetooth transport is offered. */
  readonly bluetooth?: boolean;
  /** Answers a command; every command is accepted when omitted. */
  readonly answer?: (code: number, argument: number, robot: FakeRobotControl) => CommandOutcome;
}

const OK: CommandOutcome = { status: 'ok', reason: 0 };

/** A robot that exists only in memory and serves every port of the app. */
export class FakeRobot {
  /** The ports the app needs, all served by this robot. */
  readonly ports: MonitorPorts;
  readonly #options: FakeRobotOptions;
  readonly #entries: readonly VariableInfo[];
  readonly #statusListeners = new Set<() => void>();
  readonly #schemaListeners = new Set<() => void>();
  readonly #valueListeners = new Set<() => void>();
  readonly #values = new Map<number, LiveValue>();
  readonly #held = new Map<string, number>();
  #status: ConnectionStatus = { kind: 'disconnected' };
  #variables: readonly VariableInfo[] = [];
  #timers: ReturnType<typeof setTimeout>[] = [];
  #ticker: ReturnType<typeof setInterval> | null = null;
  #startedAt = 0;
  #version = 0;

  constructor(options: FakeRobotOptions) {
    this.#options = options;
    this.ports = {
      connection: {
        status: () => this.#status,
        subscribe: (listener) => this.#listen(this.#statusListeners, listener),
        supports: (transport) => this.supports(transport),
        connect: (target) => this.connect(target),
        disconnect: () => this.disconnect(),
      },
      schema: {
        variables: () => this.#variables,
        subscribe: (listener) => this.#listen(this.#schemaListeners, listener),
      },
      values: {
        latest: (id) => this.#values.get(id),
        version: () => this.#version,
        subscribe: (listener) => this.#listen(this.#valueListeners, listener),
      },
      commands: { send: (code, argument) => this.send(code, argument) },
    };
    this.#entries = options.variables.map((variable, id) => ({
      id,
      name: variable.name,
      type: variable.type,
      access: variable.access,
      typeTag: variable.typeTag ?? null,
    }));
  }

  /** Tells whether a transport is offered. */
  supports(transport: Transport): boolean {
    return transport === 'websocket' || this.#options.bluetooth === true;
  }

  /** Connects as `ConnectionPort.connect` does. */
  connect(target: ConnectionTarget): void {
    this.#stop();

    if (target.transport === 'bluetooth' && !this.supports('bluetooth')) {
      this.#setStatus({
        kind: 'failed',
        target,
        message: 'Web Bluetooth is not available in this browser.',
      });
      return;
    }

    if (target.transport === 'websocket' && !/^wss?:\/\/\S+$/.test(target.url)) {
      this.#setStatus({ kind: 'failed', target, message: 'Enter a ws:// or wss:// URL.' });
      return;
    }

    this.#setStatus({ kind: 'connecting', target });
    this.#later(this.#options.connectMs ?? 250, () => {
      this.#setStatus({ kind: 'handshaking', target });
      this.#later(this.#options.handshakeMs ?? 450, () => this.#stream(target));
    });
  }

  /** Disconnects as `ConnectionPort.disconnect` does. */
  disconnect(): void {
    this.#stop();
    this.#setStatus({ kind: 'disconnected' });
  }

  /** Answers a command as `CommandPort.send` does. */
  send(code: number, argument = 0): Promise<CommandOutcome> {
    if (this.#status.kind !== 'streaming') {
      return Promise.resolve({ status: 'failed', message: 'Not connected to a robot.' });
    }

    return new Promise((resolve) => {
      this.#later(this.#options.commandMs ?? 40, () => {
        resolve(this.#options.answer?.(code, argument, this.#control()) ?? OK);
        this.#tick();
      });
    });
  }

  #stream(target: ConnectionTarget): void {
    this.#startedAt = Date.now();
    this.#variables = this.#entries;
    this.#tick();
    this.#ticker = setInterval(() => this.#tick(), this.#options.tickMs ?? 100);
    this.#setStatus({
      kind: 'streaming',
      target,
      robot: { name: this.#options.name, schemaHash: this.#options.schemaHash },
      since: this.#startedAt,
    });
    this.#emit(this.#schemaListeners);
  }

  #tick(): void {
    const seconds = (Date.now() - this.#startedAt) / 1000;
    this.#options.variables.forEach((variable, id) => {
      this.#values.set(id, this.#valueOf(variable, id, seconds));
    });
    this.#version += 1;
    this.#emit(this.#valueListeners);
  }

  #valueOf(variable: FakeVariable, id: number, seconds: number): LiveValue {
    if (variable.type === TypeCode.BLOB) {
      return new Uint8Array(8).fill(id);
    }

    const value =
      this.#held.get(variable.name) ??
      variable.signal?.(seconds) ??
      Math.sin(seconds * (0.3 + (id % 7) * 0.11) + id);
    return variable.type === TypeCode.F32 || variable.type === TypeCode.F64
      ? value
      : Math.round(value);
  }

  #control(): FakeRobotControl {
    return {
      hold: (name, value) => this.#held.set(name, value),
      release: (name) => this.#held.delete(name),
      valueOf: (name) => {
        const entry = this.#entries.find((variable) => variable.name === name);
        const value = entry === undefined ? undefined : this.#values.get(entry.id);
        return typeof value === 'number' ? value : undefined;
      },
    };
  }

  #listen(listeners: Set<() => void>, listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  #later(ms: number, run: () => void): void {
    this.#timers.push(setTimeout(run, ms));
  }

  #stop(): void {
    this.#timers.forEach(clearTimeout);
    this.#timers = [];

    if (this.#ticker !== null) {
      clearInterval(this.#ticker);
      this.#ticker = null;
    }

    if (this.#variables.length > 0) {
      this.#variables = [];
      this.#values.clear();
      this.#emit(this.#schemaListeners);
    }
  }

  #setStatus(status: ConnectionStatus): void {
    this.#status = status;
    this.#emit(this.#statusListeners);
  }

  #emit(listeners: ReadonlySet<() => void>): void {
    [...listeners].forEach((listener) => listener());
  }
}
