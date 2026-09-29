/**
 * An in-memory robot behind the app's ports, for development and tests until the link is wired
 * in. It goes through the same statuses a session does, feeds a real telemetry store with
 * synthetic samples ten times a second and answers commands through a callback.
 *
 * @module
 */

import { TypeCode, type Access } from '@/protocol';
import { TelemetryStore, type Scheduler, type TelemetryValue } from '@/telemetry';

import type {
  CommandOutcome,
  ConnectionStatus,
  ConnectionTarget,
  LinkPhase,
  LinkStats,
  MonitorPorts,
  RobotVariable,
  Transport,
} from '../ports';

/** A variable of the fake robot. */
export interface FakeVariable {
  readonly name: string;
  readonly type: TypeCode;
  readonly access: Access;
  readonly typeTag?: string | null;
  /** Its value at a time in seconds since the link came up; a gentle wave when omitted. */
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
  /** Milliseconds from HELLO to HELLO_ACK, and again to load the schema. */
  readonly handshakeMs?: number;
  /** Milliseconds to configure the stream groups. */
  readonly configureMs?: number;
  /** Milliseconds between two samples. */
  readonly tickMs?: number;
  /** Milliseconds to answer a command. */
  readonly commandMs?: number;
  /** Whether the Bluetooth transport is offered. */
  readonly bluetooth?: boolean;
  /** When the store tells its readers about new samples; the next animation frame by default. */
  readonly scheduler?: Scheduler;
  /** Answers a command; every command is accepted when omitted. */
  readonly answer?: (code: number, argument: number, robot: FakeRobotControl) => CommandOutcome;
}

const OK: CommandOutcome = { status: 'ok', reason: 0 };
const NO_STATS: LinkStats = {
  bytesInPerSecond: 0,
  creditWindow: 0,
  creditOutstanding: 0,
  framesDiscarded: 0,
  samplesDropped: 0,
  rttMs: Number.NaN,
  budget: { bytesPerSecond: 0, used: 0, overBudget: false, planned: [] },
};
const NO_ENTRIES: readonly never[] = [];
const NO_SUBSCRIPTION = () => () => undefined;
const GROUP = 0;

const FRAME_SCHEDULER: Scheduler = {
  schedule: (task) => {
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => task());
    } else {
      setTimeout(task, 16);
    }
  },
};

function isStreamed(variable: FakeVariable): boolean {
  return variable.access.stream && variable.type !== TypeCode.BLOB;
}

/** A robot that exists only in memory and serves every port of the app. */
export class FakeRobot {
  /** The ports the app needs, all served by this robot. */
  readonly ports: MonitorPorts;
  /** The store the values live in, as the session would feed it. */
  readonly store: TelemetryStore;
  readonly #options: FakeRobotOptions;
  readonly #entries: readonly RobotVariable[];
  readonly #streamed: readonly RobotVariable[];
  readonly #statusListeners = new Set<() => void>();
  readonly #schemaListeners = new Set<() => void>();
  readonly #held = new Map<string, number>();
  #status: ConnectionStatus = { kind: 'disconnected' };
  #variables: readonly RobotVariable[] = [];
  #timers: ReturnType<typeof setTimeout>[] = [];
  #ticker: ReturnType<typeof setInterval> | null = null;
  readonly #origin = Date.now();
  #startedAt = 0;
  #epoch = 0;
  #sequence = 0;

  constructor(options: FakeRobotOptions) {
    this.#options = options;
    this.store = new TelemetryStore({ scheduler: options.scheduler ?? FRAME_SCHEDULER });
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
      values: this.store,
      streams: { request: () => undefined },
      history: this.store,
      commands: { send: (code, argument) => this.send(code, argument) },
      writes: {
        write: () =>
          Promise.resolve({ status: 'failed', message: 'The fake robot takes no writes.' }),
        pending: () => undefined,
        subscribe: NO_SUBSCRIPTION,
      },
      reads: {
        read: (name) => {
          const latest = this.store.latest(name);
          return Promise.resolve(
            latest === undefined
              ? { status: 'failed', message: `No value of ${name}.` }
              : { status: 'ok', value: latest.value }
          );
        },
      },
      link: { stats: () => NO_STATS, subscribe: NO_SUBSCRIPTION },
      log: { entries: () => NO_ENTRIES, subscribe: NO_SUBSCRIPTION },
    };
    this.#entries = options.variables.map((variable, id) => ({
      id,
      name: variable.name,
      type: variable.type,
      access: variable.access,
      typeTag: variable.typeTag ?? null,
    }));
    this.#streamed = this.#entries.filter((_, id) => isStreamed(options.variables[id]));
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

    const handshakeMs = this.#options.handshakeMs ?? 450;
    this.#setStatus({ kind: 'connecting', target });
    this.#later(this.#options.connectMs ?? 250, () => {
      this.#setStatus({ kind: 'handshaking', target });
      this.#later(handshakeMs / 2, () => {
        this.#link(target);
        this.#later(handshakeMs / 2, () => this.#adoptSchema());
      });
    });
  }

  /** Disconnects as `ConnectionPort.disconnect` does. */
  disconnect(): void {
    this.#stop();
    this.#setStatus({ kind: 'disconnected' });
  }

  /**
   * Stops streaming to configure the groups again, as a session does when the windows ask for
   * other variables, and streams again once configured.
   */
  reconfigure(): void {
    if (this.#status.kind !== 'linked' || this.#status.phase === 'schema') {
      return;
    }

    this.#closeEpoch();
    this.#setPhase('configuring');
    this.#later(this.#options.configureMs ?? 150, () => this.#openEpoch());
  }

  /** Answers a command as `CommandPort.send` does: while the link is up, in any phase. */
  send(code: number, argument = 0): Promise<CommandOutcome> {
    if (this.#status.kind !== 'linked') {
      return Promise.resolve({ status: 'failed', message: 'Not connected to a robot.' });
    }

    return new Promise((resolve) => {
      this.#later(this.#options.commandMs ?? 40, () => {
        resolve(this.#options.answer?.(code, argument, this.#control()) ?? OK);
        this.#tick();
      });
    });
  }

  #link(target: ConnectionTarget): void {
    this.#startedAt = Date.now();
    this.#setStatus({
      kind: 'linked',
      target,
      robot: { name: this.#options.name, schemaHash: this.#options.schemaHash },
      phase: 'schema',
      since: this.#startedAt,
    });
  }

  #adoptSchema(): void {
    this.#variables = this.#entries;
    this.store.setSchema(this.#entries);
    this.#options.variables.forEach((variable, id) => {
      if (!isStreamed(variable)) {
        this.store.setLatestValue(id, this.#valueOf(variable, id, 0));
      }
    });
    this.#emit(this.#schemaListeners);
    this.#setPhase('configuring');
    this.#later(this.#options.configureMs ?? 150, () => this.#openEpoch());
  }

  #openEpoch(): void {
    this.#epoch += 1;
    this.#sequence = 0;
    this.store.openEpoch({
      epochId: this.#epoch,
      groupId: GROUP,
      variables: this.#streamed.map(({ id, type }) => ({ id, type })),
      firstSequence: 0,
    });
    this.#setPhase('streaming');
    this.#tick();
    this.#ticker = setInterval(() => this.#tick(), this.#options.tickMs ?? 100);
  }

  #closeEpoch(): void {
    if (this.#ticker !== null) {
      clearInterval(this.#ticker);
      this.#ticker = null;
      this.store.closeEpoch(this.#epoch);
    }
  }

  #tick(): void {
    if (this.#ticker === null) {
      return;
    }

    const seconds = (Date.now() - this.#startedAt) / 1000;
    const values = this.#streamed.map((entry) =>
      this.#valueOf(this.#options.variables[entry.id], entry.id, seconds)
    );
    this.store.append(this.#epoch, this.#sequence, this.#timeUs(), values);
    this.#sequence += 1;
  }

  #timeUs(): number {
    return (Date.now() - this.#origin) * 1000;
  }

  #valueOf(variable: FakeVariable, id: number, seconds: number): TelemetryValue {
    if (variable.type === TypeCode.BLOB) {
      return new Uint8Array(8).fill(id);
    }

    const value =
      this.#held.get(variable.name) ??
      variable.signal?.(seconds) ??
      Math.sin(seconds * (0.3 + (id % 7) * 0.11) + id);

    if (variable.type === TypeCode.BOOL) {
      return value !== 0;
    }

    return variable.type === TypeCode.F32 || variable.type === TypeCode.F64
      ? value
      : Math.round(value);
  }

  #control(): FakeRobotControl {
    return {
      hold: (name, value) => this.#held.set(name, value),
      release: (name) => this.#held.delete(name),
      valueOf: (name) => {
        const value = this.store.latest(name)?.value;
        return typeof value === 'number' ? value : undefined;
      },
    };
  }

  #setPhase(phase: LinkPhase): void {
    if (this.#status.kind === 'linked') {
      this.#setStatus({ ...this.#status, phase });
    }
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
    const streaming = this.#ticker !== null;
    this.#closeEpoch();

    if (streaming || this.#status.kind === 'linked') {
      this.store.markBoundary('reconnect', this.#timeUs());
    }

    if (this.#variables.length > 0) {
      this.#variables = [];
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
