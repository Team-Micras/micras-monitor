/**
 * The monitor: the one place a source's data lands. It implements the sink every connection
 * pushes into, feeds the history, the log and the timeline, keeps the status and the variables,
 * and is what the interface reads, live or over a recording.
 *
 * @module
 */

import { Emitter, type Unsubscribe } from './emitter';
import { BoundedLog, type LogEntry } from './log';
import {
  NO_STATS,
  NOT_CONNECTED,
  type BoundaryKind,
  type CommandOutcome,
  type ReadOutcome,
  type Source,
  type SourceConnection,
  type SourceIdentity,
  type SourceLog,
  type SourceSink,
  type SourceStats,
  type SourceStatus,
  type StreamDemand,
  type StreamInfo,
  type Target,
  type TargetKind,
  type WriteOutcome,
  type WriteValue,
} from './source';
import { SessionTimeline } from './timeline';
import type { Value, ValueType, Variable } from './variables';

/**
 * What the monitor writes into its history, as the history store takes it. Times are on the
 * session timeline.
 */
export interface HistoryWriter {
  /** Takes the robot's variables, which map its ids to names. */
  setSchema(variables: readonly Variable[]): void;
  /**
   * Starts a run of a stream, which the history calls an epoch. Returns the ids of the runs it
   * had to close because the new one replaces them.
   */
  openEpoch(spec: {
    readonly epochId: number;
    readonly groupId: number;
    readonly variables: readonly { readonly id: number; readonly type: ValueType }[];
  }): readonly number[];
  /** Ends a run of a stream. */
  closeEpoch(epochId: number): void;
  /** Adds a sample of an open run, after the samples lost just before it. */
  append(epochId: number, timeUs: number, values: readonly Value[], missedBefore: number): void;
  /** Records a value that did not come in a sample. */
  setLatestValue(variableId: number, value: Value): void;
  /** Marks a moment no line is drawn across, closing every open run. */
  markBoundary(kind: BoundaryKind, timeUs: number): void;
  /** Every moment marked so far, oldest first. */
  boundaries(): readonly { readonly kind: string; readonly timeUs: number }[];
}

/** A variable the interface wants streamed, by name. */
export interface VariableDemand {
  readonly variable: string;
  /** Samples per second wanted. */
  readonly rateHz: number;
  /** The role that pins it, for a variable streamed whatever is on screen. */
  readonly role?: string;
}

/**
 * Everything about the monitor that changes slowly, as one snapshot: the same object until
 * something in it changes, and each part the same object until that part changes.
 */
export interface MonitorState {
  readonly status: SourceStatus;
  /** Who the robot is: what it said when it last answered, kept while its link recovers. */
  readonly identity: SourceIdentity | null;
  /** The robot's variables, in its order; empty while none are known. */
  readonly variables: readonly Variable[];
  /** The log, oldest first. */
  readonly log: readonly LogEntry[];
  readonly stats: SourceStats;
}

/** What a monitor is built from. */
export interface MonitorOptions<H extends HistoryWriter> {
  /** Where the samples and values go. */
  readonly history: H;
  /** Where the data comes from; without one, nothing connects. */
  readonly source?: Source;
  /** How many log entries to keep. */
  readonly logLimit?: number;
  /** The host's monotonic clock in milliseconds, for the timeline; `performance.now` by default. */
  readonly now?: () => number;
}

interface OpenStream {
  readonly epochId: number;
  readonly clock: number;
}

const RECORDING_ONLY = 'A saved session is on screen: go back to live to send commands.';
const DISCONNECTED: SourceStatus = { kind: 'disconnected' };
const NO_VARIABLES: readonly Variable[] = [];

function describeTarget(target: Target): string {
  return target.transport === 'websocket' ? target.url : 'a Bluetooth robot';
}

/**
 * The monitor of one robot at a time. A live monitor connects through its source, one
 * connection at a time, and keeps one history and one timeline across connections, with a
 * boundary wherever the robot was lost or rebooted. A monitor over a recording has no source:
 * it only shows what was recorded.
 *
 * {@link state} is the same object until something slow changes, which {@link subscribe}
 * announces; samples go to the history, which has subscriptions of its own.
 */
export class Monitor<H extends HistoryWriter = HistoryWriter> {
  /** The history the samples and values go to, which the interface queries directly. */
  readonly history: H;
  /** The kinds of target the monitor can connect to; none over a recording. */
  readonly targets: readonly TargetKind[];
  readonly #source: Source | null;
  readonly #log: BoundedLog;
  readonly #timeline: SessionTimeline;
  readonly #changes = new Emitter<{ change: undefined }>();
  readonly #streams = new Map<number, OpenStream>();
  #state: MonitorState;
  #ids = new Map<string, number>();
  #demands: readonly VariableDemand[] = [];
  #connection: SourceConnection | null = null;
  #generation = 0;
  #nextEpoch = 1;

  /**
   * @param options Where the data comes from and goes to.
   */
  constructor(options: MonitorOptions<H>) {
    this.history = options.history;
    this.#source = options.source ?? null;
    this.targets = this.#source?.targets ?? [];
    this.#log = new BoundedLog(options.logLimit);
    this.#timeline = new SessionTimeline(options.now);
    this.#state = {
      status: DISCONNECTED,
      identity: null,
      variables: NO_VARIABLES,
      log: this.#log.entries,
      stats: NO_STATS,
    };
  }

  /**
   * A monitor that shows a recording: its history, and the robot and variables it was recorded
   * from. It never connects; its controls answer that there is no robot.
   */
  static ofRecording<H extends HistoryWriter>(
    history: H,
    identity: SourceIdentity | null,
    variables: readonly Variable[]
  ): Monitor<H> {
    const monitor = new Monitor({ history });
    monitor.#update({ identity, variables });
    return monitor;
  }

  /** The slow-changing state; the same object until it changes. */
  get state(): MonitorState {
    return this.#state;
  }

  /** Calls `listener` after the state changes; returns the function that stops it. */
  subscribe(listener: () => void): Unsubscribe {
    return this.#changes.on('change', listener);
  }

  /**
   * Connects to a robot through the source, ending the current connection first. Progress and
   * failure show in the status.
   */
  connect(target: Target): void {
    const source = this.#source;

    if (source === null) {
      return;
    }

    this.#end();
    const generation = ++this.#generation;
    this.#timeline.rebase();
    this.#log.add(
      this.#entry({
        severity: 'info',
        source: 'link',
        text: `connecting to ${describeTarget(target)}`,
      })
    );
    this.#update({ status: { kind: 'connecting', target }, log: this.#log.entries });
    this.#connection = source.connect(target, this.#sinkFor(generation));
    this.#connection.request(this.#demandIds());
  }

  /** Ends the connection, if any. */
  disconnect(): void {
    this.#end();
    this.#generation++;
    this.#update({ status: DISCONNECTED });
  }

  /**
   * Replaces what the interface wants streamed. Demands are kept by name, so they follow the
   * variables across connections and schema changes.
   */
  request(demands: readonly VariableDemand[]): void {
    this.#demands = demands;
    this.#connection?.request(this.#demandIds());
  }

  /** Sends a command and waits for the robot's answer. */
  command(code: number, argument = 0): Promise<CommandOutcome> {
    return this.#connection?.command(code, argument) ?? Promise.resolve(this.#notConnected());
  }

  /** Writes a variable, by name, and waits for the robot's answer. */
  write(name: string, value: WriteValue): Promise<WriteOutcome> {
    const connection = this.#connection;

    if (connection === null) {
      return Promise.resolve(this.#notConnected());
    }

    const id = this.#ids.get(name);
    return id === undefined
      ? Promise.resolve({ status: 'refused', reason: 'no-such-variable' })
      : connection.write(id, value);
  }

  /** Reads a variable, by name; the answer also becomes its latest value. */
  read(name: string): Promise<ReadOutcome> {
    const connection = this.#connection;

    if (connection === null) {
      return Promise.resolve(this.#notConnected());
    }

    const id = this.#ids.get(name);
    return id === undefined
      ? Promise.resolve({ status: 'failed', message: `The robot has no variable named ${name}.` })
      : connection.read(id);
  }

  /** The newest value written to a variable, by name, that the robot has not answered yet. */
  pendingWrite(name: string): WriteValue | undefined {
    const id = this.#ids.get(name);
    return id === undefined ? undefined : this.#connection?.pendingWrite(id);
  }

  #notConnected(): { readonly status: 'failed'; readonly message: string } {
    return { status: 'failed', message: this.#source === null ? RECORDING_ONLY : NOT_CONNECTED };
  }

  #sinkFor(generation: number): SourceSink {
    const live =
      <A extends unknown[]>(handle: (...args: A) => void) =>
      (...args: A) => {
        if (generation === this.#generation) {
          handle(...args);
        }
      };

    return {
      status: live((status) => this.#onStatus(status)),
      variables: live((variables) => this.#onVariables(variables)),
      streamOpened: live((stream) => this.#onStreamOpened(stream)),
      streamClosed: live((id) => this.#closeStream(id)),
      sample: live((stream, timeUs, values, missedBefore) => {
        const open = this.#streams.get(stream);

        if (open !== undefined) {
          const placed = this.#timeline.place(open.clock, timeUs);
          this.history.append(open.epochId, placed, values, missedBefore);
        }
      }),
      value: live((variableId, value) => this.history.setLatestValue(variableId, value)),
      boundary: live((kind) => this.#markBoundary(kind)),
      log: live((entry) => this.#addLog(entry)),
      writesChanged: live(() => this.#changes.emit('change', undefined)),
      stats: live((stats) => this.#update({ stats })),
    };
  }

  #onStatus(status: SourceStatus): void {
    if (status.kind === 'linked') {
      this.#update({ status, identity: status.identity });
    } else if (status.kind === 'disconnected' || status.kind === 'failed') {
      this.#update({ status, identity: null });
    } else {
      this.#update({ status });
    }
  }

  #onVariables(variables: readonly Variable[]): void {
    if (variables.length > 0) {
      this.history.setSchema(variables);
    }

    this.#update({ variables });
    this.#connection?.request(this.#demandIds());
  }

  #onStreamOpened({ id, slot, variableIds, clock }: StreamInfo): void {
    const known = new Map(this.#state.variables.map((variable) => [variable.id, variable]));
    const variables = variableIds.flatMap((variableId) => known.get(variableId) ?? []);

    if (variables.length !== variableIds.length) {
      const unknown = variableIds.filter((variableId) => !known.has(variableId));
      this.#addLog({
        severity: 'warning',
        source: 'link',
        text:
          `stream ${id} names variables the robot does not have ` +
          `(${unknown.join(', ')}) and is ignored`,
      });
      return;
    }

    this.#closeStream(id);
    const epochId = this.#nextEpoch++;
    const replaced = this.history.openEpoch({ epochId, groupId: slot, variables });

    for (const [streamId, open] of this.#streams) {
      if (replaced.includes(open.epochId)) {
        this.#streams.delete(streamId);
      }
    }

    this.#streams.set(id, { epochId, clock });
  }

  #closeStream(id: number): void {
    const open = this.#streams.get(id);

    if (open !== undefined) {
      this.#streams.delete(id);
      this.history.closeEpoch(open.epochId);
    }
  }

  #markBoundary(kind: BoundaryKind): void {
    for (const id of this.#streams.keys()) {
      this.#closeStream(id);
    }

    const timeUs = this.#timeline.lastUs;
    const last = this.history.boundaries().at(-1);

    if (Number.isFinite(timeUs) && (last?.timeUs !== timeUs || last.kind !== kind)) {
      this.history.markBoundary(kind, timeUs);
    }
  }

  #addLog(entry: SourceLog): void {
    this.#log.add(this.#entry(entry));
    this.#update({ log: this.#log.entries });
  }

  #entry({ severity, source, text, at }: SourceLog): LogEntry {
    const hostTime = Date.now();
    return at === undefined
      ? { hostTime, severity, source, text }
      : { timeUs: this.#timeline.place(at.clock, at.timeUs), hostTime, severity, source, text };
  }

  #end(): void {
    const connection = this.#connection;

    if (connection === null) {
      return;
    }

    this.#connection = null;
    this.#generation++;
    connection.close();
    this.#markBoundary('reconnect');
    this.#log.add(this.#entry({ severity: 'info', source: 'link', text: 'disconnected' }));
    this.#update({
      identity: null,
      variables: NO_VARIABLES,
      stats: NO_STATS,
      log: this.#log.entries,
    });
  }

  #demandIds(): StreamDemand[] {
    return this.#demands.flatMap(({ variable, rateHz, role }) => {
      const variableId = this.#ids.get(variable);

      if (variableId === undefined) {
        return [];
      }

      return role === undefined ? [{ variableId, rateHz }] : [{ variableId, rateHz, role }];
    });
  }

  #update(change: Partial<MonitorState>): void {
    const next = { ...this.#state, ...change };

    if (
      next.status === this.#state.status &&
      next.identity === this.#state.identity &&
      next.variables === this.#state.variables &&
      next.log === this.#state.log &&
      next.stats === this.#state.stats
    ) {
      return;
    }

    if (next.variables !== this.#state.variables) {
      this.#ids = new Map(next.variables.map((variable) => [variable.name, variable.id]));
    }

    this.#state = next;
    this.#changes.emit('change', undefined);
  }
}
