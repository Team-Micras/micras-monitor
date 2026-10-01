/**
 * A robot that exists only in memory, for development and demonstrations without a robot or the
 * simulation: it answers at once, streams synthetic signals, takes commands and writes after a
 * short delay and logs a few lines of its own. It does not imitate any wire protocol.
 *
 * @module
 */

import type { LogSeverity } from '@/core/log';
import {
  NOT_CONNECTED,
  type CommandOutcome,
  type ReadOutcome,
  type Source,
  type SourceConnection,
  type SourceSink,
  type SourceStats,
  type StreamDemand,
  type Target,
  type TargetKind,
  type WriteOutcome,
  type WriteValue,
} from '@/core/source';
import { isFloat, VALUE_TYPES, type Value, type Variable } from '@/core/variables';

/** A variable of a demo robot; its id is its position in the robot's list. */
export interface DemoVariable extends Omit<Variable, 'id'> {
  /** Its value at a time in seconds since the robot answered; a gentle wave when omitted. */
  readonly signal?: (seconds: number) => number;
  /** The bytes of a blob at a time in seconds since the robot answered; eight bytes of its id when omitted. */
  readonly bytes?: (seconds: number) => Uint8Array;
}

/** A line a demo robot logs by itself, once per connection. */
export interface DemoLog {
  /** When, in seconds since the robot answered. */
  readonly atSeconds: number;
  readonly severity: LogSeverity;
  readonly text: string;
}

/** What a demo robot can do while it answers a command. */
export interface DemoControl {
  /** Pins a variable to a value, overriding its signal, until `release`. */
  hold(name: string, value: number): void;
  /** Lets a variable follow its signal again. */
  release(name: string): void;
  /** The current value of a numeric variable. */
  valueOf(name: string): number | undefined;
  /** Adds a line to the log, as the robot's own. */
  log(severity: LogSeverity, text: string): void;
}

/** A demo robot: who it is, its variables, and how it answers. */
export interface DemoRobot {
  /** The name it gives, or null to stand for firmware that gives none. */
  readonly name: string | null;
  readonly schema: string;
  readonly variables: readonly DemoVariable[];
  /** Answers a command; every command is accepted when omitted. */
  readonly answer?: (code: number, argument: number, robot: DemoControl) => CommandOutcome;
  /**
   * Answers a write of a writable variable, after which a confirmed value holds; every write is
   * confirmed when omitted. Variables that are not writable are always refused.
   */
  readonly answerWrite?: (name: string, value: WriteValue, robot: DemoControl) => WriteOutcome;
  /** Lines the robot logs by itself. */
  readonly logs?: readonly DemoLog[];
}

/** How fast a demo robot is. */
export interface DemoOptions {
  /** Milliseconds it takes to answer the connection, a command, a write or a read; 40 by default. */
  readonly answerMs?: number;
  /** Samples per second of every streamed variable; 10 by default. */
  readonly sampleRateHz?: number;
  /**
   * The monotonic clock, in milliseconds, the robot times its samples by; `performance.now` by
   * default, so a step of the wall clock neither stops nor floods them.
   */
  readonly now?: () => number;
}

const OK: CommandOutcome = { status: 'ok', reason: 0 };
const CONFIRMED: WriteOutcome = { status: 'confirmed' };
const CLOSED = {
  status: 'failed',
  message: 'The connection closed before the robot answered.',
} as const;
const STREAM_ID = 0;
const SAMPLE_HEADER_BYTES = 8;
const MIN_TICK_MS = 16;
const MAX_CATCH_UP_MS = 10_000;

function isStreamed(variable: DemoVariable): boolean {
  return variable.access.stream && variable.type !== 'bytes';
}

/** Takes robot data from a demo robot. */
export class DemoSource implements Source {
  readonly id = 'demo';
  readonly targets: readonly TargetKind[] = ['websocket'];
  readonly #robot: DemoRobot;
  readonly #options: DemoOptions;

  /**
   * @param robot The robot to stand in for.
   * @param options How fast it is.
   */
  constructor(robot: DemoRobot, options: DemoOptions = {}) {
    this.#robot = robot;
    this.#options = options;
  }

  connect(target: Target, sink: SourceSink): SourceConnection {
    return new DemoConnection(this.#robot, this.#options, target, sink);
  }
}

/** One connection to a demo robot. */
class DemoConnection implements SourceConnection {
  readonly #robot: DemoRobot;
  readonly #target: Target;
  readonly #sink: SourceSink;
  readonly #answerMs: number;
  readonly #rateHz: number;
  readonly #now: () => number;
  readonly #variables: readonly Variable[];
  readonly #streamed: readonly Variable[];
  readonly #held = new Map<string, number>();
  readonly #pending = new Map<number, WriteValue>();
  readonly #unanswered = new Set<() => void>();
  readonly #timers = new Set<ReturnType<typeof setTimeout>>();
  #ticker: ReturnType<typeof setInterval> | null = null;
  #linked = false;
  #closed = false;
  #startedAt = 0;
  #nextSampleMs = 0;

  constructor(robot: DemoRobot, options: DemoOptions, target: Target, sink: SourceSink) {
    this.#robot = robot;
    this.#target = target;
    this.#sink = sink;
    this.#answerMs = options.answerMs ?? 40;
    this.#rateHz = options.sampleRateHz ?? 10;
    this.#now = options.now ?? (() => performance.now());
    this.#variables = robot.variables.map(({ name, type, access, tag }, id) =>
      tag === undefined ? { id, name, type, access } : { id, name, type, access, tag }
    );
    this.#streamed = this.#variables.filter((_, id) => isStreamed(robot.variables[id]));
    this.#later(this.#answerMs, () => this.#answer());
  }

  request(_demands: readonly StreamDemand[]): void {}

  command(code: number, argument = 0): Promise<CommandOutcome> {
    if (!this.#linked) {
      return Promise.resolve({ status: 'failed', message: NOT_CONNECTED });
    }

    this.#note('debug', `command ${code} sent`);
    return this.#reply(() => {
      const outcome = this.#robot.answer?.(code, argument, this.#control()) ?? OK;
      this.#note(outcome.status === 'ok' ? 'info' : 'warning', `command ${code} ${outcome.status}`);
      return outcome;
    });
  }

  write(variableId: number, value: WriteValue): Promise<WriteOutcome> {
    const variable = this.#variables[variableId] as Variable | undefined;

    if (!this.#linked || variable === undefined) {
      return Promise.resolve(
        this.#linked
          ? { status: 'refused', reason: 'no-such-variable' }
          : { status: 'failed', message: NOT_CONNECTED }
      );
    }

    this.#pending.set(variableId, value);
    this.#sink.writesChanged();
    this.#note('debug', `write ${variable.name} = ${String(value)} sent`);

    return this.#reply(() => {
      const outcome: WriteOutcome = variable.access.write
        ? (this.#robot.answerWrite?.(variable.name, value, this.#control()) ?? CONFIRMED)
        : { status: 'refused', reason: 'read-only' };

      if (outcome.status === 'confirmed') {
        this.#held.set(variable.name, Number(value));

        if (!isStreamed(this.#robot.variables[variableId])) {
          this.#sink.value(variableId, this.#valueOf(variableId, 0));
        }
      }

      if (this.#pending.get(variableId) === value) {
        this.#pending.delete(variableId);
      }

      this.#note(
        outcome.status === 'confirmed' ? 'info' : 'warning',
        `write ${variable.name} = ${String(value)} ${outcome.status === 'refused' ? `refused: ${outcome.reason}` : outcome.status}`
      );
      this.#sink.writesChanged();
      return outcome;
    });
  }

  read(variableId: number): Promise<ReadOutcome> {
    if (!this.#linked || this.#variables[variableId] === undefined) {
      return Promise.resolve({
        status: 'failed',
        message: this.#linked ? `The robot has no variable ${variableId}.` : NOT_CONNECTED,
      });
    }

    return this.#reply(() => {
      const value = this.#valueOf(variableId, this.#seconds(this.#now()));
      this.#sink.value(variableId, value);
      return { status: 'ok', value };
    });
  }

  pendingWrite(variableId: number): WriteValue | undefined {
    return this.#pending.get(variableId);
  }

  close(): void {
    this.#closed = true;
    this.#timers.forEach(clearTimeout);
    this.#timers.clear();
    this.#unanswered.forEach((abandon) => abandon());
    this.#unanswered.clear();
    this.#pending.clear();

    if (this.#ticker !== null) {
      clearInterval(this.#ticker);
      this.#ticker = null;
    }
  }

  #answer(): void {
    this.#linked = true;
    this.#startedAt = this.#now();
    const { name, schema, variables, logs } = this.#robot;
    this.#sink.status({
      kind: 'linked',
      target: this.#target,
      identity: { name, schema },
      since: Date.now(),
    });
    this.#sink.variables(this.#variables);
    this.#note('info', `${name ?? 'the robot'} answered with ${variables.length} variables`);
    variables.forEach((variable, id) => {
      if (!isStreamed(variable)) {
        this.#sink.value(id, this.#valueOf(id, 0));
      }
    });

    for (const { atSeconds, severity, text } of logs ?? []) {
      this.#later(atSeconds * 1000, () => this.#log(severity, text));
    }

    this.#sink.streamOpened({
      id: STREAM_ID,
      slot: 0,
      variableIds: this.#streamed.map((variable) => variable.id),
      clock: 0,
    });
    this.#sink.stats(this.#stats());
    this.#nextSampleMs = this.#startedAt;
    this.#ticker = setInterval(() => this.#tick(), this.#tickMs());
    this.#tick();
  }

  #tick(immediately = false): void {
    if (this.#ticker === null) {
      return;
    }

    const stepMs = 1000 / this.#rateHz;
    const nowMs = this.#now();
    let atMs = Math.max(this.#nextSampleMs, nowMs - MAX_CATCH_UP_MS);

    if (immediately && atMs > nowMs) {
      atMs = nowMs;
    }

    for (; atMs <= nowMs; atMs += stepMs) {
      const seconds = this.#seconds(atMs);
      const values = this.#streamed.map((variable) => this.#valueOf(variable.id, seconds));
      this.#sink.sample(STREAM_ID, atMs * 1000, values, 0);
    }

    this.#nextSampleMs = atMs;
  }

  #stats(): SourceStats {
    const sampleBytes =
      SAMPLE_HEADER_BYTES +
      this.#streamed.reduce((total, variable) => total + VALUE_TYPES[variable.type].size, 0);

    return {
      bytesInPerSecond: sampleBytes * this.#rateHz,
      rttMs: Number.NaN,
      samplesDropped: 0,
      framesDiscarded: 0,
      gauges: [],
      streams: this.#streamed.map(({ id }) => ({
        variableId: id,
        askedHz: this.#rateHz,
        grantedHz: this.#rateHz,
      })),
    };
  }

  #tickMs(): number {
    return Math.max(MIN_TICK_MS, 1000 / this.#rateHz);
  }

  #seconds(atMs: number): number {
    return (atMs - this.#startedAt) / 1000;
  }

  #valueOf(id: number, seconds: number): Value {
    const variable = this.#robot.variables[id];

    if (variable.type === 'bytes') {
      return variable.bytes?.(seconds) ?? new Uint8Array(8).fill(id);
    }

    const value =
      this.#held.get(variable.name) ??
      variable.signal?.(seconds) ??
      Math.sin(seconds * (0.3 + (id % 7) * 0.11) + id);

    if (variable.type === 'bool') {
      return value !== 0;
    }

    return isFloat(variable.type) ? value : Math.round(value);
  }

  #control(): DemoControl {
    return {
      hold: (name, value) => this.#held.set(name, value),
      release: (name) => this.#held.delete(name),
      valueOf: (name) => {
        const id = this.#variables.findIndex((variable) => variable.name === name);
        const value = id < 0 ? undefined : this.#valueOf(id, this.#seconds(this.#now()));
        return typeof value === 'number' ? value : undefined;
      },
      log: (severity, text) => this.#log(severity, text),
    };
  }

  #reply<T>(answer: () => T): Promise<T | typeof CLOSED> {
    return new Promise((resolve) => {
      const abandon = () => resolve(CLOSED);
      this.#unanswered.add(abandon);
      this.#later(this.#answerMs, () => {
        this.#unanswered.delete(abandon);
        resolve(answer());
        this.#tick(true);
      });
    });
  }

  #log(severity: LogSeverity, text: string): void {
    this.#sink.log({
      severity,
      source: 'robot',
      text,
      at: { clock: 0, timeUs: this.#now() * 1000 },
    });
  }

  #note(severity: LogSeverity, text: string): void {
    this.#sink.log({ severity, source: 'link', text });
  }

  #later(ms: number, run: () => void): void {
    if (this.#closed) {
      return;
    }

    const timer = setTimeout(() => {
      this.#timers.delete(timer);
      run();
    }, ms);
    this.#timers.add(timer);
  }
}
