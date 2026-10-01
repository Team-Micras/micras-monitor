/**
 * The source that reaches a robot over `micras_comm`: a link over WebSocket or Bluetooth and
 * the stream planner that owns its groups, mapped onto the monitor's model.
 *
 * @module
 */

import type { Unsubscribe } from '@/core/emitter';
import type { LogSeverity } from '@/core/log';
import {
  NOT_CONNECTED,
  type CommandOutcome,
  type ReadOutcome,
  type Source,
  type SourceConnection,
  type SourceSink,
  type SourceStats,
  type SourceStatus,
  type StreamDemand,
  type Target,
  type TargetKind,
  type WriteOutcome,
  type WriteRefusal,
  type WriteValue,
} from '@/core/source';
import type { Variable } from '@/core/variables';

import { connectionStatus, isLinkUp, sameStatus } from './connection-status';
import { BluetoothTransport } from './transports/bluetooth/bluetooth-transport';
import { MemorySchemaCache, type SchemaCache, type SchemaEntry } from './link/schema';
import { RobotLink } from './link/robot-link';
import { StreamPlanner, type StreamPlannerOptions } from './streaming/stream-planner';
import { WebSocketTransport, type WebSocketFactory } from './transports/websocket-transport';
import type { BluetoothLike } from './transports/bluetooth/bluetooth-types';
import type { Epoch } from './link/epochs';
import type {
  EpochEndEvent,
  SampleEvent,
  LinkState,
  LinkTiming,
  TimelineEvent,
} from './link/link-events';
import type { RateRequest } from './streaming/fit-groups';
import type { Transport, TransportState } from './transports/transport';
import { variableOf } from './value-types';
import { asError } from './link/errors';
import { CommandResult, Severity, WriteStatus } from './wire';

/** What the source is built from; everything has a default. */
export interface MicrasCommOptions {
  /** The link's timeouts and periods, over the defaults for a radio link. */
  readonly timing?: Partial<LinkTiming>;
  /** How the stream planner plans. */
  readonly planner?: StreamPlannerOptions;
  /** `navigator.bluetooth`, when the browser has it. */
  readonly bluetooth?: BluetoothLike;
  /** Opens WebSockets; the runtime's own by default. */
  readonly createSocket?: WebSocketFactory;
  /** Where schemas are kept between connections; in memory, for the life of the source, by default. */
  readonly schemaCache?: SchemaCache;
}

/** A robot link with the transport under it and the planner over it. */
interface Link {
  readonly transport: Transport;
  readonly session: RobotLink;
  readonly planner: StreamPlanner;
}

/** A link whose Bluetooth transport stopped until the user clicks. */
type ParkedLink = Link & { readonly transport: BluetoothTransport };

/** The sequence numbers of one stream, and where its variables sit in a sample. */
interface StreamState {
  readonly gaps: SequenceGaps;
  readonly variableIds: readonly number[];
}

const WEBSOCKET_URL = /^wss?:\/\/\S+$/;
const SEQUENCE_MODULUS = 2 ** 16;

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

const SEVERITIES: Readonly<Record<Severity, LogSeverity>> = {
  [Severity.DEBUG]: 'debug',
  [Severity.INFO]: 'info',
  [Severity.WARNING]: 'warning',
  [Severity.ERROR]: 'error',
};

function describeState(state: LinkState): string | null {
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

function waitsForGesture(link: Link): link is ParkedLink {
  const { transport } = link;
  return (
    transport instanceof BluetoothTransport &&
    transport.state.kind === 'closed' &&
    transport.state.reason === 'needs-user-gesture'
  );
}

function closeLink({ session, planner }: Link): void {
  planner.close();
  session.close();
}

/**
 * Counts the samples of a stream that went missing from its `u16` sequence numbers. A sample whose
 * time repeats or goes back is stale: it moves the count on only when it carries the expected
 * number, so that it does not look like a wrap over lost samples.
 */
class SequenceGaps {
  #expected: number | undefined;
  #lastUs = Number.NEGATIVE_INFINITY;

  /**
   * @param first The number the stream starts at, or undefined for one that carries on another,
   *   whose first sample sets the count.
   */
  constructor(first: number | undefined) {
    this.#expected = first;
  }

  /** How many samples went missing just before one with this number and time. */
  receive(sequence: number, timeUs: number): number {
    const expected = this.#expected;

    if (timeUs <= this.#lastUs) {
      if (sequence === expected) {
        this.#expected = (sequence + 1) % SEQUENCE_MODULUS;
      }

      return 0;
    }

    this.#lastUs = timeUs;
    this.#expected = (sequence + 1) % SEQUENCE_MODULUS;
    return expected === undefined ? 0 : (sequence - expected + SEQUENCE_MODULUS) % SEQUENCE_MODULUS;
  }
}

/**
 * Reaches robots over `micras_comm`. Each connection gets a link and a stream planner of its
 * own; a Bluetooth link that waits for a click is kept, so that connecting to Bluetooth again
 * reaches the same device instead of asking for another.
 */
export class MicrasCommSource implements Source {
  readonly id = 'micras-comm';
  readonly targets: readonly TargetKind[];
  readonly #options: MicrasCommOptions;
  readonly #schemaCache: SchemaCache;
  #parked: ParkedLink | null = null;
  #current: MicrasCommConnection | null = null;

  /**
   * @param options What the source is built from.
   */
  constructor(options: MicrasCommOptions = {}) {
    this.#options = options;
    this.#schemaCache = options.schemaCache ?? new MemorySchemaCache();
    this.targets = options.bluetooth === undefined ? ['websocket'] : ['websocket', 'bluetooth'];
  }

  /** The link of the latest connection, if it has one, for diagnostics. */
  get session(): RobotLink | undefined {
    return this.#current?.link?.session;
  }

  /** The stream planner of the latest connection, if it has one, for diagnostics. */
  get planner(): StreamPlanner | undefined {
    return this.#current?.link?.planner;
  }

  connect(target: Target, sink: SourceSink): SourceConnection {
    const parked = this.#parked;
    this.#parked = null;
    const connection = new MicrasCommConnection(target, sink, (link) => this.#park(link));
    this.#current = connection;

    if (parked !== null && target.transport === 'bluetooth') {
      connection.start(parked);
      return connection;
    }

    if (parked !== null) {
      closeLink(parked);
    }

    if (target.transport === 'websocket') {
      if (WEBSOCKET_URL.test(target.url)) {
        const { createSocket } = this.#options;
        connection.start(this.#link(new WebSocketTransport(target.url, { createSocket })));
      } else {
        connection.fail('Enter a ws:// or wss:// URL.');
      }

      return connection;
    }

    const bluetooth = this.#options.bluetooth;

    if (bluetooth === undefined) {
      connection.fail('Web Bluetooth is not available in this browser.');
      return connection;
    }

    sink.status({ kind: 'connecting', target });
    BluetoothTransport.request({ bluetooth }).then(
      (transport) => connection.start(this.#link(transport)),
      (error: unknown) =>
        error instanceof Error && error.name === 'NotFoundError'
          ? connection.cancel()
          : connection.fail(asError(error).message)
    );
    return connection;
  }

  #link(transport: Transport): Link {
    const session = new RobotLink(transport, {
      timing: this.#options.timing,
      schemaCache: this.#schemaCache,
    });
    return { transport, session, planner: new StreamPlanner(session, this.#options.planner) };
  }

  #park(link: ParkedLink): void {
    if (this.#parked !== null) {
      closeLink(this.#parked);
    }

    this.#parked = link;
  }
}

/** One connection: the protocol work between a link and the monitor's sink. */
class MicrasCommConnection implements SourceConnection {
  readonly #target: Target;
  readonly #sink: SourceSink;
  readonly #park: (link: ParkedLink) => void;
  readonly #streams = new Map<number, StreamState>();
  readonly #continuedGroups = new Set<number>();
  #link: Link | null = null;
  #detach: readonly Unsubscribe[] = [];
  #closed = false;
  #status: SourceStatus | null = null;
  #since = 0;
  #schema: readonly SchemaEntry[] | undefined;
  #variables: readonly Variable[] = [];
  #robotName: string | null = null;
  #demands: readonly StreamDemand[] = [];
  #clock = 0;
  #droppedSinceStats = 0;
  #credit: number | undefined;

  constructor(target: Target, sink: SourceSink, park: (link: ParkedLink) => void) {
    this.#target = target;
    this.#sink = sink;
    this.#park = park;
  }

  /** The link the connection runs over, once it has one. */
  get link(): Link | null {
    return this.#link;
  }

  /**
   * Runs over a link: listens to it and opens its robot link, or reaches its Bluetooth device again
   * if it waits for a click, unless the connection was closed meanwhile.
   */
  start(link: Link): void {
    if (this.#closed) {
      closeLink(link);
      return;
    }

    const { transport, session, planner } = link;
    this.#link = link;
    this.#detach = [
      transport.onState((state) => this.#onTransportState(state)),
      transport.onError((error) => this.#note('warning', error.message)),
      session.on('state', (state) => this.#onState(state)),
      session.on('schema', () => this.#refreshVariables()),
      session.on('epoch', (epoch) => this.#onEpoch(epoch)),
      session.on('epochEnd', (event) => this.#onEpochEnd(event)),
      session.on('sample', (sample) => this.#onSample(sample)),
      session.on('timeline', (event) => this.#onTimeline(event)),
      session.on('dropped', ({ count }) => {
        this.#droppedSinceStats += count;
      }),
      session.on('value', ({ variableId, value }) => this.#sink.value(variableId, value)),
      session.on('write', () => this.#sink.writesChanged()),
      session.on('log', ({ severity, text, timeUs }) =>
        this.#sink.log({
          severity: SEVERITIES[severity] ?? 'info',
          source: 'robot',
          text,
          at: { clock: this.#clock, timeUs },
        })
      ),
      session.on('protocolError', ({ message }) => this.#note('warning', message)),
      session.on('stats', () => this.#onStats()),
      planner.on('plan', () => this.#refreshStats()),
      planner.on('error', (error) => this.#note('warning', `stream plan: ${error.message}`)),
    ];
    planner.request(this.#rateRequests());

    if (waitsForGesture(link)) {
      link.transport.reconnect();
    } else {
      session.open();
    }

    this.#refreshStatus();
    this.#refreshVariables();
  }

  /** Ends before a link was found, with an error the user has to act on. */
  fail(message: string): void {
    if (!this.#closed) {
      this.#setStatus({ kind: 'failed', target: this.#target, message });
    }
  }

  /** Ends before a link was found, because the user gave up, as on the Bluetooth chooser. */
  cancel(): void {
    if (!this.#closed) {
      this.#setStatus({ kind: 'disconnected' });
    }
  }

  request(demands: readonly StreamDemand[]): void {
    this.#demands = demands;
    this.#link?.planner.request(this.#rateRequests());
  }

  async command(code: number, argument = 0): Promise<CommandOutcome> {
    const session = this.#linkedSession();

    if (session === undefined) {
      return { status: 'failed', message: NOT_CONNECTED };
    }

    try {
      const reply = await session.command(code, argument);
      return { status: COMMAND_STATUS[reply.result], reason: reply.reason ?? null };
    } catch (error) {
      return { status: 'failed', message: asError(error).message };
    }
  }

  async write(variableId: number, value: WriteValue): Promise<WriteOutcome> {
    const session = this.#linkedSession();

    if (session === undefined) {
      return { status: 'failed', message: NOT_CONNECTED };
    }

    try {
      const result = await session.write(variableId, value);

      if (result.status === 'superseded') {
        return { status: 'superseded' };
      }

      return result.writeStatus === WriteStatus.OK
        ? { status: 'confirmed' }
        : { status: 'refused', reason: WRITE_REFUSAL[result.writeStatus] };
    } catch (error) {
      return { status: 'failed', message: asError(error).message };
    }
  }

  async read(variableId: number): Promise<ReadOutcome> {
    const session = this.#linkedSession();

    if (session === undefined) {
      return { status: 'failed', message: NOT_CONNECTED };
    }

    try {
      return { status: 'ok', value: await session.read(variableId) };
    } catch (error) {
      return { status: 'failed', message: asError(error).message };
    }
  }

  pendingWrite(variableId: number): WriteValue | undefined {
    return this.#link?.session.pendingWrite(variableId);
  }

  close(): void {
    if (this.#closed) {
      return;
    }

    this.#closed = true;
    const link = this.#link;
    this.#link = null;
    this.#detach.forEach((unsubscribe) => unsubscribe());
    this.#detach = [];

    if (link === null) {
      return;
    }

    if (waitsForGesture(link)) {
      this.#park(link);
    } else {
      closeLink(link);
    }
  }

  #linkedSession(): RobotLink | undefined {
    return this.#status?.kind === 'linked' ? this.#link?.session : undefined;
  }

  #onTransportState(state: TransportState): void {
    if (state.kind === 'closed' && state.reason === 'taken-over' && state.error !== undefined) {
      this.#note('warning', state.error.message);
    }

    this.#refreshStatus();
  }

  #note(severity: LogSeverity, text: string): void {
    this.#sink.log({ severity, source: 'link', text });
  }

  #rateRequests(): RateRequest[] {
    const names = new Map(this.#variables.map((variable) => [variable.id, variable.name]));

    return this.#demands.flatMap(({ variableId, rateHz, role }) => {
      const variable = names.get(variableId);

      if (variable === undefined) {
        return [];
      }

      return role === undefined
        ? [{ variable, rateHz }]
        : [{ variable, rateHz, pinned: true, countsDrops: role === 'link.dropped' }];
    });
  }

  #onState(state: LinkState): void {
    const text = describeState(state);

    if (text !== null) {
      this.#note(state.kind === 'error' ? 'error' : 'info', text);
    }

    if (
      state.kind === 'disconnected' ||
      (state.kind === 'handshaking' && state.attempt === 1 && state.reason !== 'connected')
    ) {
      this.#streams.clear();
      this.#sink.boundary('reconnect');
    }

    this.#refreshVariables();
    this.#refreshStatus();
  }

  /**
   * Tells the monitor the robot's variables when the link learns a schema. While the same robot
   * loads a different one, as after a new build, the variables known stay, so the robot package
   * on screen does not flicker; the link refuses requests until the new schema is in, and
   * another robot, by name, drops them at once.
   */
  #refreshVariables(): void {
    const session = this.#link?.session;
    const schema = session?.schema;

    if (schema === this.#schema) {
      return;
    }

    if (schema !== undefined) {
      this.#schema = schema;
      this.#robotName = session?.robot?.robotName ?? null;
      this.#setVariables(schema.map(variableOf));
      return;
    }

    if ((session?.robot?.robotName ?? null) !== this.#robotName) {
      this.#schema = undefined;
      this.#setVariables([]);
    }
  }

  #setVariables(variables: readonly Variable[]): void {
    this.#variables = variables;
    this.#sink.variables(variables);
  }

  #onEpoch(epoch: Epoch): void {
    const continued = this.#continuedGroups.delete(epoch.group);
    this.#streams.set(epoch.id, {
      gaps: new SequenceGaps(continued ? undefined : 0),
      variableIds: epoch.variableIds,
    });
    this.#sink.streamOpened({
      id: epoch.id,
      slot: epoch.group,
      variableIds: epoch.variableIds,
      clock: epoch.timeline,
    });
  }

  #onEpochEnd({ epoch, reason }: EpochEndEvent): void {
    if (reason === 'clock-reset') {
      this.#continuedGroups.add(epoch.group);
    }

    if (this.#streams.delete(epoch.id)) {
      this.#sink.streamClosed(epoch.id);
    }
  }

  #onSample({ epoch, seq, timeUs, values }: SampleEvent): void {
    const stream = this.#streams.get(epoch);

    if (stream === undefined) {
      return;
    }

    const creditId = this.#demands.find((demand) => demand.role === 'link.credit')?.variableId;
    const creditAt = creditId === undefined ? -1 : stream.variableIds.indexOf(creditId);

    if (creditAt >= 0) {
      this.#credit = Number(values[creditAt]);
    }

    this.#sink.sample(epoch, timeUs, values, stream.gaps.receive(seq, timeUs));
  }

  /**
   * A reboot and a reset of the robot's clock both mark a `reboot` boundary: either way the times
   * before and after belong to different runs of the clock.
   */
  #onTimeline({ id, reason }: TimelineEvent): void {
    this.#clock = id;

    if (reason !== 'connected') {
      this.#sink.boundary('reboot');
      this.#note('warning', reason === 'reboot' ? 'the robot rebooted' : "the robot's clock reset");
    }
  }

  #onStats(): void {
    if (this.#droppedSinceStats > 0) {
      this.#note('warning', `${this.#droppedSinceStats} samples dropped`);
      this.#droppedSinceStats = 0;
    }

    this.#refreshStats();
  }

  #refreshStats(): void {
    const link = this.#link;

    if (link === null) {
      return;
    }

    this.#sink.stats(this.#stats(link));
  }

  #stats({ session, planner }: Link): SourceStats {
    const stats = session.stats;
    const budget = planner.budget;
    const plan = planner.plan;
    const window = session.robot?.creditWindow ?? 0;
    const ids = new Map(this.#variables.map((variable) => [variable.name, variable.id]));
    const available = this.#credit;

    return {
      bytesInPerSecond: budget.bytesInPerSecond,
      rttMs: stats.rttMs ?? Number.NaN,
      samplesDropped: stats.droppedSamples,
      framesDiscarded: stats.framesDiscarded,
      gauges: [
        {
          label: 'Credit',
          used: available === undefined ? 0 : Math.max(0, window - available),
          capacity: window,
          unit: 'B',
          warn: false,
        },
        {
          label: 'Budget',
          used: plan?.usedBytesPerSecond ?? 0,
          capacity: budget.bytesPerSecond,
          unit: 'B/s',
          warn: plan?.overBudget ?? false,
        },
      ],
      streams: (plan?.rates ?? []).flatMap(({ variable, rateHz, grantedHz }) => {
        const variableId = ids.get(variable);
        return variableId === undefined ? [] : [{ variableId, askedHz: rateHz, grantedHz }];
      }),
    };
  }

  #refreshStatus(): void {
    const link = this.#link;

    if (link === null || this.#closed) {
      return;
    }

    const { session, transport } = link;
    const up = isLinkUp(session.state);

    if (up && this.#since === 0) {
      this.#since = Date.now();
    } else if (!up) {
      this.#since = 0;
    }

    this.#setStatus(
      connectionStatus({
        target: this.#target,
        transport: transport.state,
        session: session.state,
        robot: session.robot,
        since: this.#since,
      })
    );
  }

  /** Reports a new status; one that ends the link also tells the sink the variables are gone. */
  #setStatus(status: SourceStatus): void {
    if (this.#status !== null && sameStatus(this.#status, status)) {
      return;
    }

    this.#status = status;
    this.#sink.status(status);

    if (status.kind === 'failed' || status.kind === 'disconnected') {
      this.#schema = undefined;

      if (this.#variables.length > 0) {
        this.#setVariables([]);
      }
    }
  }
}
