/**
 * The robot behind the app's ports when there is a real one: a link session over WebSocket or
 * Bluetooth, the stream planner that owns its groups, and the telemetry store it feeds.
 *
 * @module
 */

import type { Variable } from '@/core/variables';
import {
  BluetoothTransport,
  MemorySchemaCache,
  Session,
  StreamPlanner,
  WebSocketTransport,
  type BluetoothLike,
  type Epoch,
  type EpochEndEvent,
  type RateRequest,
  type SampleEvent,
  type SchemaCache,
  type SchemaEntry,
  type SessionState,
  type SessionTiming,
  type StreamPlannerOptions,
  type TimelineEvent,
  type Transport,
  type WebSocketFactory,
  valueTypeOf,
  variableOf,
} from '@/link';
import { CommandResult, WriteStatus } from '@/protocol';
import { TelemetryStore, type Scheduler } from '@/telemetry';

import type {
  CommandOutcome,
  ConnectionStatus,
  ConnectionTarget,
  LinkStats,
  MonitorPorts,
  ReadOutcome,
  StreamRequest,
  Transport as TransportKind,
  WriteOutcome,
  WriteRefusal,
  WriteValue,
} from '../ports';
import { LiveLog, logSeverity } from './live-log';
import { connectionStatus, linkPhase, sameStatus } from './live-status';
import { SessionTimeline } from './session-timeline';

/** What a live robot is built from; everything has a default. */
export interface LiveRobotOptions {
  /** When the store tells its readers about new samples; about once a frame, on a timer, by default. */
  readonly scheduler?: Scheduler;
  /** The session's timeouts and periods, over the defaults for a radio link. */
  readonly timing?: Partial<SessionTiming>;
  /** How the stream planner plans. */
  readonly planner?: StreamPlannerOptions;
  /** `navigator.bluetooth`, when the browser has it. */
  readonly bluetooth?: BluetoothLike;
  /** Opens WebSockets; the runtime's own by default. */
  readonly createSocket?: WebSocketFactory;
  /** Where schemas are kept between sessions; in memory, for the life of the robot, by default. */
  readonly schemaCache?: SchemaCache;
  /** How many log entries to keep. */
  readonly logLimit?: number;
  /** The most memory the store's history may take; the store's default otherwise. */
  readonly memoryCapBytes?: number;
}

interface ActiveLink {
  readonly target: ConnectionTarget;
  readonly transport: Transport;
  readonly session: Session;
  readonly planner: StreamPlanner;
  readonly detach: readonly (() => void)[];
  since: number;
}

const NOT_CONNECTED = 'Not connected to a robot.';
const WEBSOCKET_URL = /^wss?:\/\/\S+$/;

const TIMER_SCHEDULER: Scheduler = { schedule: (task) => setTimeout(task, 16) };

const COMMAND_STATUS: Readonly<Record<CommandResult, 'ok' | 'unknown' | 'refused' | 'deferred'>> = {
  [CommandResult.OK]: 'ok',
  [CommandResult.UNKNOWN]: 'unknown',
  [CommandResult.REFUSED]: 'refused',
  [CommandResult.DEFERRED]: 'deferred',
};

const WRITE_REFUSAL: Readonly<Record<Exclude<WriteStatus, WriteStatus.OK>, WriteRefusal>> = {
  [WriteStatus.NO_SUCH_ID]: 'no-such-variable',
  [WriteStatus.READ_ONLY]: 'read-only',
  [WriteStatus.NEEDS_IDLE]: 'needs-idle',
  [WriteStatus.WRONG_SIZE]: 'wrong-size',
};

const NO_STATS: LinkStats = {
  bytesInPerSecond: 0,
  creditWindow: 0,
  creditOutstanding: 0,
  framesDiscarded: 0,
  samplesDropped: 0,
  rttMs: Number.NaN,
  budget: { bytesPerSecond: 0, used: 0, overBudget: false, planned: [] },
};

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function rateRequests(request: StreamRequest): RateRequest[] {
  return [
    ...request.pinned.map(({ role, variable, rateHz }) => ({
      variable,
      rateHz,
      pinned: true,
      countsDrops: role === 'link.dropped',
    })),
    ...request.windows.map(({ variable, rateHz }) => ({ variable, rateHz })),
  ];
}

function describeState(state: SessionState): string | null {
  switch (state.kind) {
    case 'handshaking':
      return state.attempt === 1 ? `handshake (${state.reason})` : null;
    case 'loadingSchema':
      return state.received === 0 ? `loading a schema of ${state.total} variables` : null;
    case 'streaming':
      return 'streaming';
    case 'disconnected':
      return 'transport closed';
    case 'error':
      return state.error.message;
    default:
      return null;
  }
}

/**
 * A robot reached over a real link, serving every port of the app.
 *
 * One store lasts for the life of the app, so history survives reconnections; each connection
 * gets a session and a stream planner of its own. Times go onto one session timeline, with a
 * boundary wherever the link lost the robot or the robot rebooted.
 */
export class LiveRobot {
  /** The ports the app needs. */
  readonly ports: MonitorPorts;
  /** The store the session feeds. */
  readonly store: TelemetryStore;
  /** The robot's LOG messages and the link's own events. */
  readonly log: LiveLog;
  readonly #options: LiveRobotOptions;
  readonly #schemaCache: SchemaCache;
  readonly #timeline = new SessionTimeline();
  readonly #statusListeners = new Set<() => void>();
  readonly #schemaListeners = new Set<() => void>();
  readonly #writeListeners = new Set<() => void>();
  readonly #statsListeners = new Set<() => void>();
  readonly #epochTimelines = new Map<number, number>();
  readonly #continuedGroups = new Set<number>();
  #link: ActiveLink | null = null;
  #status: ConnectionStatus = { kind: 'disconnected' };
  #schemaSource: readonly SchemaEntry[] | undefined;
  #variables: readonly Variable[] = [];
  #stats: LinkStats = NO_STATS;
  #request: StreamRequest = { windows: [], pinned: [] };
  #currentTimeline = 0;
  #droppedSinceStats = 0;
  #attempt = 0;

  /**
   * @param options What the robot is built from.
   */
  constructor(options: LiveRobotOptions = {}) {
    this.#options = options;
    this.#schemaCache = options.schemaCache ?? new MemorySchemaCache();
    this.store = new TelemetryStore({
      scheduler: options.scheduler ?? TIMER_SCHEDULER,
      memoryCapBytes: options.memoryCapBytes,
    });
    this.log = new LiveLog(options.logLimit);
    this.ports = {
      connection: {
        status: () => this.#status,
        subscribe: (listener) => listen(this.#statusListeners, listener),
        supports: (transport) => this.supports(transport),
        connect: (target) => this.connect(target),
        disconnect: () => this.disconnect(),
      },
      schema: {
        variables: () => this.#variables,
        subscribe: (listener) => listen(this.#schemaListeners, listener),
      },
      values: this.store,
      streams: { request: (request) => this.request(request) },
      history: this.store,
      commands: { send: (code, argument) => this.send(code, argument) },
      writes: {
        write: (name, value) => this.write(name, value),
        pending: (name) => this.pending(name),
        subscribe: (listener) => listen(this.#writeListeners, listener),
      },
      reads: { read: (name) => this.read(name) },
      link: {
        stats: () => this.#stats,
        subscribe: (listener) => listen(this.#statsListeners, listener),
      },
      log: this.log,
    };
  }

  /** The session of the current connection, if any. */
  get session(): Session | undefined {
    return this.#link?.session;
  }

  /** The stream planner of the current connection, if any. */
  get planner(): StreamPlanner | undefined {
    return this.#link?.planner;
  }

  /** Tells whether a transport can be used here. */
  supports(transport: TransportKind): boolean {
    return transport === 'websocket' || this.#options.bluetooth !== undefined;
  }

  /**
   * Connects as `ConnectionPort.connect` does. Asked again for the Bluetooth device it already
   * has, while that one waits for a gesture, it reconnects to it instead of asking for another.
   */
  connect(target: ConnectionTarget): void {
    const link = this.#link;

    if (
      target.transport === 'bluetooth' &&
      link?.transport instanceof BluetoothTransport &&
      link.transport.state.kind === 'closed' &&
      link.transport.state.reason === 'needs-user-gesture'
    ) {
      link.transport.reconnect();
      return;
    }

    this.#teardown();
    const attempt = ++this.#attempt;

    if (target.transport === 'websocket') {
      if (!WEBSOCKET_URL.test(target.url)) {
        this.#setStatus({ kind: 'failed', target, message: 'Enter a ws:// or wss:// URL.' });
        return;
      }

      this.#start(
        target,
        new WebSocketTransport(target.url, { createSocket: this.#options.createSocket })
      );
      return;
    }

    const bluetooth = this.#options.bluetooth;

    if (bluetooth === undefined) {
      this.#setStatus({
        kind: 'failed',
        target,
        message: 'Web Bluetooth is not available in this browser.',
      });
      return;
    }

    this.#setStatus({ kind: 'connecting', target });
    BluetoothTransport.request({ bluetooth }).then(
      (transport) => {
        if (attempt === this.#attempt) {
          this.#start(target, transport);
        }
      },
      (error: unknown) => {
        if (attempt !== this.#attempt) {
          return;
        }

        if (error instanceof Error && error.name === 'NotFoundError') {
          this.#setStatus({ kind: 'disconnected' });
        } else {
          this.#setStatus({ kind: 'failed', target, message: messageOf(error) });
        }
      }
    );
  }

  /** Disconnects as `ConnectionPort.disconnect` does. */
  disconnect(): void {
    this.#attempt++;
    this.#teardown();
    this.#setStatus({ kind: 'disconnected' });
  }

  /** Takes what the app wants streamed, as `StreamPort.request` does. */
  request(request: StreamRequest): void {
    this.#request = request;
    this.#link?.planner.request(rateRequests(request));
  }

  /** Sends a command as `CommandPort.send` does. */
  async send(code: number, argument = 0): Promise<CommandOutcome> {
    const session = this.#linkedSession();

    if (!session) {
      return { status: 'failed', message: NOT_CONNECTED };
    }

    try {
      const reply = await session.command(code, argument);
      return { status: COMMAND_STATUS[reply.result], reason: reply.reason ?? null };
    } catch (error) {
      return { status: 'failed', message: messageOf(error) };
    }
  }

  /** Writes a variable as `WritePort.write` does. */
  async write(name: string, value: WriteValue): Promise<WriteOutcome> {
    const session = this.#linkedSession();

    if (!session) {
      return { status: 'failed', message: NOT_CONNECTED };
    }

    const id = this.#idOf(name);

    if (id === undefined) {
      return { status: 'refused', reason: 'no-such-variable' };
    }

    try {
      const result = await session.write(id, value);

      if (result.status === 'superseded') {
        return { status: 'superseded' };
      }

      return result.writeStatus === WriteStatus.OK
        ? { status: 'confirmed' }
        : { status: 'refused', reason: WRITE_REFUSAL[result.writeStatus] };
    } catch (error) {
      return { status: 'failed', message: messageOf(error) };
    }
  }

  /** The value of the newest write the robot has not answered, as `WritePort.pending` says. */
  pending(name: string): WriteValue | undefined {
    const id = this.#idOf(name);
    return id === undefined ? undefined : this.#link?.session.pendingWrite(id);
  }

  /** Reads a variable as `ReadPort.read` does; the answer also becomes its latest value. */
  async read(name: string): Promise<ReadOutcome> {
    const session = this.#linkedSession();

    if (!session) {
      return { status: 'failed', message: NOT_CONNECTED };
    }

    const id = this.#idOf(name);

    if (id === undefined) {
      return { status: 'failed', message: `The robot has no variable named ${name}.` };
    }

    try {
      return { status: 'ok', value: await session.read(id) };
    } catch (error) {
      return { status: 'failed', message: messageOf(error) };
    }
  }

  #linkedSession(): Session | undefined {
    return this.#status.kind === 'linked' ? this.#link?.session : undefined;
  }

  #idOf(name: string): number | undefined {
    return this.#link?.session.schema?.find((entry) => entry.name === name)?.id;
  }

  #start(target: ConnectionTarget, transport: Transport): void {
    const session = new Session(transport, {
      timing: this.#options.timing,
      schemaCache: this.#schemaCache,
    });
    const planner = new StreamPlanner(session, this.#options.planner);
    const link: ActiveLink = {
      target,
      transport,
      session,
      planner,
      since: 0,
      detach: [
        transport.onState(() => this.#refreshStatus()),
        session.on('state', (state) => this.#onState(state)),
        session.on('schema', ({ entries }) => this.#onSchema(entries)),
        session.on('epoch', (epoch) => this.#onEpoch(epoch)),
        session.on('epochEnd', (event) => this.#onEpochEnd(event)),
        session.on('sample', (sample) => this.#onSample(sample)),
        session.on('timeline', (event) => this.#onTimeline(event)),
        session.on('dropped', ({ count }) => {
          this.#droppedSinceStats += count;
        }),
        session.on('value', ({ variableId, value }) =>
          this.store.setLatestValue(variableId, value)
        ),
        session.on('write', () => emit(this.#writeListeners)),
        session.on('log', ({ severity, text, timeUs }) =>
          this.log.robot(
            logSeverity(severity),
            text,
            this.#timeline.place(this.#currentTimeline, timeUs)
          )
        ),
        session.on('protocolError', ({ message }) => this.log.link('warning', message)),
        session.on('stats', () => this.#onStats()),
        planner.on('plan', () => this.#refreshStats()),
        planner.on('error', (error) => this.log.link('warning', `stream plan: ${error.message}`)),
      ],
    };

    this.#link = link;
    this.#timeline.rebase();
    planner.request(rateRequests(this.#request));
    this.log.link('info', `connecting to ${describeTarget(target)}`);
    this.#refreshStatus();
    session.open();
  }

  #teardown(): void {
    const link = this.#link;

    if (!link) {
      return;
    }

    this.#link = null;
    link.detach.forEach((unsubscribe) => unsubscribe());
    link.planner.close();
    link.session.close();
    this.#markBoundary('reconnect');
    this.#stats = NO_STATS;
    emit(this.#statsListeners);
    this.#refreshSchema();
    this.log.link('info', 'disconnected');
  }

  #onState(state: SessionState): void {
    const text = describeState(state);

    if (text !== null) {
      this.log.link(state.kind === 'error' ? 'error' : 'info', text);
    }

    if (
      state.kind === 'disconnected' ||
      (state.kind === 'handshaking' && state.attempt === 1 && state.reason !== 'connected')
    ) {
      this.#markBoundary('reconnect');
    }

    this.#refreshSchema();
    this.#refreshStatus();
  }

  #onSchema(entries: readonly SchemaEntry[]): void {
    this.store.setSchema(entries.map(variableOf));
    this.#refreshSchema();
  }

  #onEpoch(epoch: Epoch): void {
    const schema = this.#link?.session.schema;

    if (!schema) {
      return;
    }

    const continued = this.#continuedGroups.delete(epoch.group);
    this.store.openEpoch({
      epochId: epoch.id,
      groupId: epoch.group,
      variables: epoch.variableIds.map((id) => ({ id, type: valueTypeOf(schema[id].type) })),
      firstSequence: continued ? undefined : 0,
    });
    this.#epochTimelines.set(epoch.id, epoch.timeline);
  }

  #onEpochEnd({ epoch, reason }: EpochEndEvent): void {
    if (reason === 'clock-reset') {
      this.#continuedGroups.add(epoch.group);
    }

    if (this.#epochTimelines.delete(epoch.id)) {
      this.store.closeEpoch(epoch.id);
    }
  }

  #onSample(sample: SampleEvent): void {
    const timeline = this.#epochTimelines.get(sample.epoch);

    if (timeline !== undefined) {
      this.store.append(
        sample.epoch,
        sample.seq,
        this.#timeline.place(timeline, sample.timeUs),
        sample.values
      );
    }
  }

  /**
   * A reboot and a reset of the robot's clock both mark a `reboot` boundary: the store knows no
   * kind for a clock that started over without the robot rebooting, and either way the times
   * before and after belong to different runs of the clock.
   */
  #onTimeline({ id, reason }: TimelineEvent): void {
    this.#currentTimeline = id;

    if (reason !== 'connected') {
      this.#markBoundary('reboot');
      this.log.link(
        'warning',
        reason === 'reboot' ? 'the robot rebooted' : "the robot's clock reset"
      );
    }
  }

  #onStats(): void {
    if (this.#droppedSinceStats > 0) {
      this.log.link('warning', `${this.#droppedSinceStats} samples dropped`);
      this.#droppedSinceStats = 0;
    }

    this.#refreshStats();
  }

  #markBoundary(kind: 'reconnect' | 'reboot'): void {
    for (const epochId of this.#epochTimelines.keys()) {
      this.store.closeEpoch(epochId);
    }

    this.#epochTimelines.clear();
    const timeUs = this.#timeline.lastUs;

    const last = this.store.boundaries().at(-1);

    if (Number.isFinite(timeUs) && (last?.timeUs !== timeUs || last.kind !== kind)) {
      this.store.markBoundary(kind, timeUs);
    }
  }

  #refreshStats(): void {
    const link = this.#link;

    if (!link) {
      return;
    }

    const { session, planner } = link;
    const stats = session.stats;
    const budget = planner.budget;
    const plan = planner.plan;
    const window = session.robot?.creditWindow ?? 0;

    this.#stats = {
      bytesInPerSecond: budget.bytesInPerSecond,
      creditWindow: window,
      creditOutstanding: this.#creditOutstanding(window),
      framesDiscarded: stats.framesDiscarded,
      samplesDropped: stats.droppedSamples,
      rttMs: stats.rttMs ?? Number.NaN,
      budget: {
        bytesPerSecond: budget.bytesPerSecond,
        used: plan?.usedBytesPerSecond ?? 0,
        overBudget: plan?.overBudget ?? false,
        planned: (plan?.rates ?? []).map(({ variable, rateHz, grantedHz }) => ({
          variable,
          rateHz,
          grantedHz,
        })),
      },
    };
    emit(this.#statsListeners);
  }

  #creditOutstanding(window: number): number {
    const variable = this.#request.pinned.find((demand) => demand.role === 'link.credit')?.variable;
    const available = variable === undefined ? undefined : this.store.latest(variable)?.value;

    return typeof available === 'number' ? Math.max(0, window - available) : 0;
  }

  #refreshSchema(): void {
    const entries = this.#link?.session.schema;

    if (entries !== this.#schemaSource) {
      this.#schemaSource = entries;
      this.#variables = entries?.map(variableOf) ?? [];
      emit(this.#schemaListeners);
    }
  }

  #refreshStatus(): void {
    const link = this.#link;

    if (!link) {
      return;
    }

    const { session } = link;
    const up = linkPhase(session.state) !== null;

    if (up && link.since === 0) {
      link.since = Date.now();
    } else if (!up) {
      link.since = 0;
    }

    this.#setStatus(
      connectionStatus({
        target: link.target,
        transport: link.transport.state,
        session: session.state,
        robot: session.robot,
        since: link.since,
      })
    );
  }

  #setStatus(status: ConnectionStatus): void {
    if (!sameStatus(this.#status, status)) {
      this.#status = status;
      emit(this.#statusListeners);
    }
  }
}

function describeTarget(target: ConnectionTarget): string {
  return target.transport === 'websocket' ? target.url : 'a Bluetooth robot';
}

function listen(listeners: Set<() => void>, listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function emit(listeners: ReadonlySet<() => void>): void {
  [...listeners].forEach((listener) => listener());
}
