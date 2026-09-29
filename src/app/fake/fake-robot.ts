/**
 * An in-memory robot behind the app's ports, for development and tests until the link is wired
 * in. It goes through the same statuses a session does, feeds a real telemetry store with
 * synthetic samples, answers commands and writes after a delay, and keeps a log and link
 * counters that look like a session's.
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
  LogEntry,
  LogSeverity,
  MonitorPorts,
  ReadOutcome,
  RobotVariable,
  Transport,
  WriteOutcome,
  WriteValue,
} from '../ports';

/** A variable of the fake robot. */
export interface FakeVariable {
  readonly name: string;
  readonly type: TypeCode;
  readonly access: Access;
  readonly typeTag?: string | null;
  /** Its value at a time in seconds since the link came up; a gentle wave when omitted. */
  readonly signal?: (seconds: number) => number;
  /** The bytes of a blob at a time in seconds since the link came up; eight bytes of its id when omitted. */
  readonly bytes?: (seconds: number) => Uint8Array;
}

/** A line the fake robot logs by itself. */
export interface FakeLog {
  readonly atSeconds: number;
  readonly severity: LogSeverity;
  readonly text: string;
}

/** What the fake robot can do while it answers a command. */
export interface FakeRobotControl {
  /** Pins a variable to a value, overriding its signal, until `release`. */
  hold(name: string, value: number): void;
  /** Lets a variable follow its signal again. */
  release(name: string): void;
  /** The current value of a numeric variable. */
  valueOf(name: string): number | undefined;
  /** Adds a line to the log, as the robot's LOG. */
  log(severity: LogSeverity, text: string): void;
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
  /** Milliseconds between two batches of samples. */
  readonly tickMs?: number;
  /**
   * Samples appended per batch, spread evenly over the tick; one by default. A batch that comes
   * late catches up on the samples due since the last one, as a robot keeps its own clock.
   */
  readonly samplesPerTick?: number;
  /** Tells which samples the link loses, by sequence number; none by default. */
  readonly drops?: (sequence: number) => boolean;
  /** Milliseconds to answer a command. */
  readonly commandMs?: number;
  /** Whether the Bluetooth transport is offered. */
  readonly bluetooth?: boolean;
  /** When the store tells its readers about new samples; the next animation frame by default. */
  readonly scheduler?: Scheduler;
  /** Answers a command; every command is accepted when omitted. */
  readonly answer?: (code: number, argument: number, robot: FakeRobotControl) => CommandOutcome;
  /**
   * Answers a write of a writable variable, after which a confirmed value holds; every write is
   * confirmed when omitted. Variables the schema marks read only are always refused.
   */
  readonly answerWrite?: (name: string, value: WriteValue, robot: FakeRobotControl) => WriteOutcome;
  /** Lines the robot logs, each once per connection, at a time since the schema loaded. */
  readonly logs?: readonly FakeLog[];
  /** The bytes per second the fake planner may spend; 3 KB/s, as a Bluetooth link, by default. */
  readonly budgetBytesPerSecond?: number;
}

const OK: CommandOutcome = { status: 'ok', reason: 0 };
const CONFIRMED: WriteOutcome = { status: 'confirmed' };
const CLOSED = {
  status: 'failed',
  message: 'The connection closed before the robot answered.',
} as const;
const GROUP = 0;
const CREDIT_WINDOW = 256;
const LOG_LIMIT = 500;
const SAMPLE_HEADER_BYTES = 8;
const MAX_CATCH_UP_MS = 10_000;

const NO_STATS: LinkStats = {
  bytesInPerSecond: 0,
  creditWindow: CREDIT_WINDOW,
  creditOutstanding: 0,
  framesDiscarded: 0,
  samplesDropped: 0,
  rttMs: Number.NaN,
  budget: { bytesPerSecond: 0, used: 0, overBudget: false, planned: [] },
};

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

function sizeOf(type: TypeCode): number {
  switch (type) {
    case TypeCode.BOOL:
    case TypeCode.U8:
    case TypeCode.I8:
      return 1;
    case TypeCode.U16:
    case TypeCode.I16:
      return 2;
    case TypeCode.U64:
    case TypeCode.I64:
    case TypeCode.F64:
      return 8;
    default:
      return 4;
  }
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
  readonly #pending = new Map<string, WriteValue>();
  readonly #writeListeners = new Set<() => void>();
  readonly #linkListeners = new Set<() => void>();
  readonly #logListeners = new Set<() => void>();
  #logEntries: readonly LogEntry[] = [];
  #stats: LinkStats = NO_STATS;
  readonly #unanswered = new Set<() => void>();
  #status: ConnectionStatus = { kind: 'disconnected' };
  #variables: readonly RobotVariable[] = [];
  #timers: ReturnType<typeof setTimeout>[] = [];
  #ticker: ReturnType<typeof setInterval> | null = null;
  readonly #origin = Date.now();
  #startedAt = 0;
  #epoch = 0;
  #sequence = 0;
  #dropped = 0;
  #nextSampleMs = 0;

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
        write: (name, value) => this.write(name, value),
        pending: (name) => this.#pending.get(name),
        subscribe: (listener) => this.#listen(this.#writeListeners, listener),
      },
      reads: { read: (name) => this.read(name) },
      link: {
        stats: () => this.#stats,
        subscribe: (listener) => this.#listen(this.#linkListeners, listener),
      },
      log: {
        entries: () => this.#logEntries,
        subscribe: (listener) => this.#listen(this.#logListeners, listener),
      },
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

    this.log('debug', `command ${code} sent`, 'link');
    return new Promise((resolve) => {
      this.#later(this.#options.commandMs ?? 40, () => {
        const outcome = this.#options.answer?.(code, argument, this.#control()) ?? OK;
        this.log(
          outcome.status === 'ok' ? 'info' : 'warning',
          `command ${code} ${outcome.status}`,
          'link'
        );
        resolve(outcome);
        this.#tick(true);
      });
    });
  }

  /**
   * Writes a variable as `WritePort.write` does: pending until the answer, after a command's
   * delay; a confirmed value holds until the next write.
   */
  write(name: string, value: WriteValue): Promise<WriteOutcome> {
    if (this.#status.kind !== 'linked') {
      return Promise.resolve({ status: 'failed', message: 'Not connected to a robot.' });
    }

    const id = this.#variables.findIndex((variable) => variable.name === name);
    const entry = this.#variables[id];

    if (entry === undefined) {
      return Promise.resolve({ status: 'refused', reason: 'no-such-variable' });
    }

    this.#pending.set(name, value);
    this.#emit(this.#writeListeners);
    this.log('debug', `write ${name} = ${String(value)} sent`, 'link');

    return new Promise((resolve) => {
      const abandon = () => resolve(CLOSED);
      this.#unanswered.add(abandon);
      this.#later(this.#options.commandMs ?? 40, () => {
        this.#unanswered.delete(abandon);
        const outcome = entry.access.write
          ? (this.#options.answerWrite?.(name, value, this.#control()) ?? CONFIRMED)
          : ({ status: 'refused', reason: 'read-only' } as const);

        if (outcome.status === 'confirmed') {
          this.#held.set(name, Number(value));

          if (!isStreamed(this.#options.variables[id])) {
            this.store.setLatestValue(id, this.#valueOf(this.#options.variables[id], id, 0));
          }
        }

        if (this.#pending.get(name) === value) {
          this.#pending.delete(name);
        }

        this.log(
          outcome.status === 'confirmed' ? 'info' : 'warning',
          `write ${name} = ${String(value)} ${outcome.status === 'refused' ? `refused: ${outcome.reason}` : outcome.status}`,
          'link'
        );
        this.#emit(this.#writeListeners);
        resolve(outcome);
        this.#tick(true);
      });
    });
  }

  /** Reads a variable as `ReadPort.read` does, after a command's delay. */
  read(name: string): Promise<ReadOutcome> {
    if (this.#status.kind !== 'linked' || this.#status.phase === 'schema') {
      return Promise.resolve({ status: 'failed', message: 'Not connected to a robot.' });
    }

    const id = this.#variables.findIndex((variable) => variable.name === name);

    if (id < 0) {
      return Promise.resolve({ status: 'failed', message: `The robot has no ${name}.` });
    }

    return new Promise((resolve) => {
      const abandon = () => resolve(CLOSED);
      this.#unanswered.add(abandon);
      this.#later(this.#options.commandMs ?? 40, () => {
        this.#unanswered.delete(abandon);
        const seconds = (Date.now() - this.#startedAt) / 1000;
        const value = this.#valueOf(this.#options.variables[id], id, seconds);
        this.store.setLatestValue(id, value);
        resolve({ status: 'ok', value });
      });
    });
  }

  /** Adds a line to the log, as the robot's LOG or a link event. */
  log(severity: LogSeverity, text: string, source: LogEntry['source'] = 'robot'): void {
    const entry: LogEntry =
      source === 'robot'
        ? { timeUs: this.#timeUs(), hostTime: Date.now(), severity, source, text }
        : { hostTime: Date.now(), severity, source, text };
    this.#logEntries = [...this.#logEntries.slice(-(LOG_LIMIT - 1)), entry];
    this.#emit(this.#logListeners);
  }

  #link(target: ConnectionTarget): void {
    this.#startedAt = Date.now();
    this.log('info', 'HELLO_ACK received', 'link');
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
    this.log('info', `schema loaded, ${this.#entries.length} variables`, 'link');

    for (const { atSeconds, severity, text } of this.#options.logs ?? []) {
      this.#later(atSeconds * 1000, () => this.log(severity, text));
    }

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
    this.log('info', `group ${GROUP} streaming ${this.#streamed.length} variables`, 'link');
    this.#nextSampleMs = Date.now() - (this.#samplesPerTick() - 1) * this.#stepMs();
    this.#ticker = setInterval(() => this.#tick(), this.#tickMs());
    this.#tick();
  }

  #closeEpoch(): void {
    if (this.#ticker !== null) {
      clearInterval(this.#ticker);
      this.#ticker = null;
      this.store.closeEpoch(this.#epoch);
    }
  }

  #tick(immediately = false): void {
    if (this.#ticker === null) {
      return;
    }

    const stepMs = this.#stepMs();
    const nowMs = Date.now();
    let atMs = Math.max(this.#nextSampleMs, nowMs - MAX_CATCH_UP_MS);

    if (immediately && atMs > nowMs) {
      atMs = nowMs;
    }

    for (; atMs <= nowMs; atMs += stepMs) {
      this.#sample(atMs);
    }

    this.#nextSampleMs = atMs;
    this.#updateStats();
  }

  #sample(atMs: number): void {
    const seconds = (atMs - this.#startedAt) / 1000;
    const values = this.#streamed.map((entry) =>
      this.#valueOf(this.#options.variables[entry.id], entry.id, seconds)
    );

    if (this.#options.drops?.(this.#sequence) === true) {
      this.#dropped += 1;
    } else {
      this.store.append(this.#epoch, this.#sequence, (atMs - this.#origin) * 1000, values);
    }

    this.#sequence += 1;
  }

  #samplesPerTick(): number {
    return this.#options.samplesPerTick ?? 1;
  }

  #stepMs(): number {
    return this.#tickMs() / this.#samplesPerTick();
  }

  #tickMs(): number {
    return this.#options.tickMs ?? 100;
  }

  #updateStats(): void {
    const rateHz = 1000 / this.#stepMs();
    const sampleBytes =
      SAMPLE_HEADER_BYTES + this.#streamed.reduce((total, entry) => total + sizeOf(entry.type), 0);
    const used = sampleBytes * rateHz;
    const bytesPerSecond = this.#options.budgetBytesPerSecond ?? 3000;
    const overBudget = used > bytesPerSecond;
    const grantedHz = overBudget ? Math.floor((rateHz * bytesPerSecond) / used) : rateHz;
    const seconds = (Date.now() - this.#startedAt) / 1000;
    this.#stats = {
      bytesInPerSecond: Math.min(used, bytesPerSecond),
      creditWindow: CREDIT_WINDOW,
      creditOutstanding: Math.round(CREDIT_WINDOW * (0.35 + 0.25 * Math.sin(seconds * 1.3))),
      framesDiscarded: 0,
      samplesDropped: this.#dropped,
      rttMs: 48 + 6 * Math.sin(seconds * 0.7),
      budget: {
        bytesPerSecond,
        used: Math.min(used, bytesPerSecond),
        overBudget,
        planned: this.#streamed.map(({ name }) => ({ variable: name, rateHz, grantedHz })),
      },
    };
    this.#emit(this.#linkListeners);
  }

  #timeUs(): number {
    return (Date.now() - this.#origin) * 1000;
  }

  #valueOf(variable: FakeVariable, id: number, seconds: number): TelemetryValue {
    if (variable.type === TypeCode.BLOB) {
      return variable.bytes?.(seconds) ?? new Uint8Array(8).fill(id);
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
      log: (severity, text) => this.log(severity, text),
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
    this.#unanswered.forEach((abandon) => abandon());
    this.#unanswered.clear();

    if (this.#pending.size > 0) {
      this.#pending.clear();
      this.#emit(this.#writeListeners);
    }

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
