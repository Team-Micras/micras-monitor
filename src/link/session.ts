import { Emitter, type Listener, type Unsubscribe } from '@/core/emitter';

import {
  ErrorCode,
  FrameReader,
  MessageType,
  PROTOCOL_VERSION,
  readValue,
  TypeCode,
  validateValue,
  writeValue,
  type Frame,
  type Fundamental,
} from '../protocol';
import { Backoff } from './backoff';
import { TimestampUnwrapper } from './clock';
import { CumulativeCredit, isMetered, wireSize, type CreditPolicy } from './credit';
import { SessionError } from './errors';
import { GroupConfigurator } from './group-configurator';
import {
  EpochRegistry,
  sharedEpochIds,
  type Epoch,
  type EpochEndReason,
  type EpochIdSource,
  type GroupRequest,
} from './groups';
import { LinkCounters } from './link-counters';
import { LinkWatchdog } from './link-watchdog';
import {
  decodeMessage,
  encodeCommand,
  encodeCredit,
  encodeHello,
  encodeRead,
  isSupported,
  type CommandAck,
  type CommandReply,
  type ForeignHelloAck,
  type HelloAck,
  type Pong,
  type RobotMessage,
  type Sample,
} from './messages';
import { OneAtATime } from './one-at-a-time';
import { PendingRequests, type RequestKind } from './requests';
import { MemorySchemaCache, type SchemaCache, type SchemaEntry } from './schema';
import { SchemaLoader, type SchemaProgress } from './schema-loader';
import {
  DEFAULT_TIMING,
  type GroupsResult,
  type HandshakeReason,
  type LinkStats,
  type ReadResult,
  type RobotInfo,
  type SessionEvents,
  type SessionState,
  type SessionTiming,
  type TimelineEvent,
  type WriteResult,
} from './session-types';
import type { Transport } from './transport';
import { VariableWrites } from './variable-writes';

/** What a session is built from; everything has a default. */
export interface SessionOptions {
  /** Where schemas are kept between sessions; in memory by default. */
  schemaCache?: SchemaCache;

  /** When to give credit back; protocol version 2's coalesced total by default. */
  creditPolicy?: CreditPolicy;

  /** Timeouts and periods, over the defaults for a radio link. */
  timing?: Partial<SessionTiming>;

  /** Where epoch ids come from; a counter shared by every session on the page by default. */
  epochIds?: EpochIdSource;
}

type Timer = ReturnType<typeof setTimeout>;

const LINK_UP_STATES = new Set<SessionState['kind']>(['loadingSchema', 'configuring', 'streaming']);

/**
 * A session with one robot over one transport: the handshake, the schema, the stream groups,
 * the credit window and every request with its answer.
 *
 * It is a state machine driven by the bytes the transport pushes and by its own timers, and it
 * reports through typed events. It recovers on its own from what a radio link does: pages and
 * answers that go missing, credit that is lost with a corrupted frame, a robot that reboots or
 * goes silent. While the transport is open it never gives up on the robot; only what retrying
 * cannot fix, such as another protocol version, ends in `error`.
 */
export class Session {
  private readonly events = new Emitter<SessionEvents>();
  private readonly reader = new FrameReader();
  private readonly requests = new PendingRequests();
  private readonly clock = new TimestampUnwrapper();
  private readonly counters = new LinkCounters();
  private readonly sizeRefusals = new OneAtATime();
  private readonly credit: CreditPolicy;
  private readonly timing: SessionTiming;
  private readonly helloBackoff: Backoff;
  private readonly schemaLoader: SchemaLoader;
  private readonly epochs: EpochRegistry;
  private readonly groups: GroupConfigurator;
  private readonly watchdog: LinkWatchdog;
  private readonly writes: VariableWrites;
  private readonly detach: Unsubscribe[];

  private current: SessionState = { kind: 'disconnected' };
  private info: RobotInfo | undefined;
  private adoptedHash: number | undefined;
  private handshakeReason: HandshakeReason = 'connected';
  private helloAttempt = 0;
  private generation = 0;
  private timeline = 0;
  private discardedSeen = 0;
  private activeEpochs: readonly Epoch[] | null = null;

  private stateTimer: Timer | undefined;
  private creditTimer: Timer | undefined;
  private statsTimer: ReturnType<typeof setInterval> | undefined;

  /**
   * @param transport The byte pipe to the robot. The session starts its handshake as soon as the
   * transport is open, and closes it when the session is closed.
   * @param options What the session is built from.
   */
  constructor(
    private readonly transport: Transport,
    options: SessionOptions = {}
  ) {
    this.credit = options.creditPolicy ?? new CumulativeCredit();
    this.timing = { ...DEFAULT_TIMING, ...options.timing };
    this.helloBackoff = new Backoff({
      initialMs: this.timing.helloTimeoutMs,
      maxMs: this.timing.helloBackoffMaxMs,
      factor: 2,
    });
    this.schemaLoader = new SchemaLoader(options.schemaCache ?? new MemorySchemaCache(), {
      send: (frame) => this.send(frame),
      report: (message) => this.reportProtocolError(message),
    });
    this.epochs = new EpochRegistry(
      {
        opened: (epoch) => this.onEpochOpened(epoch),
        ended: (epoch, reason) => this.onEpochEnded(epoch, reason),
      },
      options.epochIds ?? sharedEpochIds
    );
    this.groups = this.createGroupConfigurator();
    this.watchdog = this.createWatchdog();
    this.writes = new VariableWrites({
      send: (frame) => this.send(frame),
      requests: this.requests,
      timing: this.timing,
      emit: (event) => this.events.emit('write', event),
    });
    this.detach = [
      transport.onBytes((bytes) => this.onBytes(bytes)),
      transport.onState(() => this.onTransportState()),
    ];
    this.onTransportState();
  }

  /** Where the session is now. */
  get state(): SessionState {
    return this.current;
  }

  /** What the last HELLO_ACK said about the robot. */
  get robot(): RobotInfo | undefined {
    return this.info;
  }

  /** The robot's schema, once known; unknown again while a different one loads. */
  get schema(): readonly SchemaEntry[] | undefined {
    return this.schemaLoader.schema;
  }

  /** The epochs samples are arriving for, by group. The same array until one begins or ends. */
  get openEpochs(): readonly Epoch[] {
    this.activeEpochs ??= Object.freeze(this.epochs.active());
    return this.activeEpochs;
  }

  /** The counters of the link. The same object until one of them changes. */
  get stats(): LinkStats {
    return this.counters.snapshot;
  }

  /**
   * Listen to an event.
   *
   * @returns A function that removes the listener.
   */
  on<K extends keyof SessionEvents>(event: K, listener: Listener<SessionEvents[K]>): Unsubscribe {
    return this.events.on(event, listener);
  }

  /** Open the transport, which starts the handshake. */
  open(): void {
    if (this.current.kind !== 'closed') {
      this.transport.open();
    }
  }

  /** Redo the handshake, such as after an error. */
  restart(): void {
    if (this.current.kind === 'closed') {
      return;
    }

    if (this.transport.state.kind === 'open') {
      this.startHandshake('restart');
    } else {
      this.transport.open();
    }
  }

  /** End the session and close the transport. Every pending request fails. */
  close(): void {
    if (this.current.kind === 'closed') {
      return;
    }

    const closed = new SessionError('closed', 'The session was closed');

    this.stopActivity(closed, 'disconnected');
    this.stopStats();
    this.groups.rejectWaiters(closed);
    this.detach.forEach((unsubscribe) => unsubscribe());
    this.transport.close();
    this.setState({ kind: 'closed' });
  }

  /**
   * Choose what streams: one request per group, replacing every group asked for before. Groups
   * not in the list stop streaming.
   *
   * A group only changes once the robot acknowledged it, and every definition opens a new epoch.
   * The layout is kept, and applied again every time the handshake is redone; while the transport
   * is down the promise waits for it to come back. A group the robot refuses is dropped from the
   * layout, and the promise fails with the reason once every other group was applied. A later
   * call before this one was applied settles it as `superseded`.
   *
   * @param requests The groups, at most `MAX_GROUPS`.
   * @returns The epochs streaming once the robot acknowledged the whole layout.
   */
  setGroups(requests: readonly GroupRequest[]): Promise<GroupsResult> {
    if (this.current.kind === 'closed') {
      return Promise.reject(new SessionError('closed'));
    }

    if (this.current.kind === 'error') {
      return Promise.reject(this.notReady());
    }

    const schema = this.schema;

    if (!schema) {
      return Promise.reject(new SessionError('not-ready', 'The schema is not known yet'));
    }

    const result = this.groups.request(schema, requests);

    if (this.current.kind === 'configuring' || this.current.kind === 'streaming') {
      this.groups.configure();
    }

    return result;
  }

  /**
   * Write a variable.
   *
   * The value is pending until the robot acknowledges it; `pendingWrite` and the `write` event
   * say so, and neither ever reports it confirmed before the WRITE_ACK. Only one write per
   * variable is in flight: a newer one waits for it, and replaces any other that was waiting.
   *
   * @param variableId The variable.
   * @param value Its new value, which has to fit its type.
   * @returns What the robot answered, or that a newer write replaced this one before it was sent.
   */
  async write(variableId: number, value: Fundamental): Promise<WriteResult> {
    const entry = this.requireEntry(variableId);

    if (entry.type === TypeCode.BLOB) {
      throw new Error(`${entry.name} is a blob; only primitives can be written`);
    }

    validateValue(value, entry.type);
    return this.writes.write(variableId, value, writeValue(value, entry.type));
  }

  /** The value of the newest write to a variable that the robot has not answered yet. */
  pendingWrite(variableId: number): Fundamental | undefined {
    return this.writes.pending(variableId);
  }

  /**
   * Read the current value of a variable, streamed or not.
   *
   * The robot refuses a blob too large for a frame with GROUP_TOO_LARGE, as it refuses a group
   * definition, and the context of either may be the same number; so a blob READ waits for a
   * GROUP_DEFINE the robot has not answered, and a GROUP_DEFINE waits for it.
   *
   * @param variableId The variable.
   * @returns Its value, or the bytes of a blob.
   */
  async read(variableId: number): Promise<ReadResult> {
    const entry = this.requireEntry(variableId);
    const bytes =
      entry.type === TypeCode.BLOB
        ? await this.sizeRefusals.run(() => this.requestBlob(variableId, entry))
        : await this.requestValue(variableId, false);
    const value = decodeReadValue(entry, bytes);

    this.events.emit('value', { variableId, value });
    return value;
  }

  /**
   * Ask the robot to act once.
   *
   * @param code The command, as the robot numbers them.
   * @param argument Whatever the command takes, as a u32.
   * @returns What the robot answered, and why when the protocol version says.
   */
  command(code: number, argument = 0): Promise<CommandReply> {
    if (!Number.isInteger(code) || code < 0 || code > 0xff) {
      return Promise.reject(new Error(`A command code is a byte, got ${code}`));
    }

    if (!Number.isInteger(argument) || argument < 0 || argument > 0xffffffff) {
      return Promise.reject(new Error(`A command argument is a u32, got ${argument}`));
    }

    if (!LINK_UP_STATES.has(this.current.kind)) {
      return Promise.reject(this.notReady());
    }

    const answer = this.requests.add(
      'command',
      code,
      this.timing.requestTimeoutMs,
      (error, context) => error === ErrorCode.MALFORMED && context === code
    );

    this.send(encodeCommand(code, argument));
    return answer;
  }

  private requestBlob(variableId: number, entry: SchemaEntry): Promise<Uint8Array> {
    if (this.requireEntry(variableId) !== entry) {
      throw this.notReady();
    }

    return this.requestValue(variableId, true);
  }

  private requestValue(variableId: number, mayBeTooLarge: boolean): Promise<Uint8Array> {
    const answer = this.requests.add(
      'read',
      variableId,
      this.timing.requestTimeoutMs,
      (code, context) =>
        context === variableId &&
        (code === ErrorCode.NO_SUCH_VARIABLE ||
          (mayBeTooLarge && code === ErrorCode.GROUP_TOO_LARGE))
    );

    this.send(encodeRead(variableId));
    return answer;
  }

  private createGroupConfigurator(): GroupConfigurator {
    return new GroupConfigurator(
      {
        send: (frame) => this.send(frame),
        requests: this.requests,
        sizeRefusals: this.sizeRefusals,
        timing: this.timing,
        generation: () => this.generation,
        timeline: () => this.timeline,
        configuring: () => this.setState({ kind: 'configuring' }),
        settled: () => this.setState({ kind: 'streaming' }),
        report: (message) => this.reportProtocolError(message),
      },
      this.epochs
    );
  }

  private createWatchdog(): LinkWatchdog {
    return new LinkWatchdog({
      send: (frame) => this.send(frame),
      requests: this.requests,
      timing: this.timing,
      streamingPeriodMs: () => this.streamingPeriodMs(),
      answered: (roundTripMs) => this.counters.set('rttMs', roundTripMs),
      silent: () => this.startHandshake('keepalive'),
      stalled: () => this.startHandshake('stall'),
    });
  }

  private onTransportState(): void {
    if (this.current.kind === 'closed') {
      return;
    }

    if (this.transport.state.kind === 'open') {
      this.reader.clear();
      this.startStats();
      this.startHandshake('connected');
    } else if (this.current.kind !== 'disconnected') {
      this.stopActivity(new SessionError('disconnected', 'The transport closed'), 'disconnected');
      this.stopStats();
      this.reader.clear();
      this.setState({ kind: 'disconnected' });
    }
  }

  private startHandshake(reason: HandshakeReason): void {
    this.stopActivity(
      new SessionError('restarted', `The handshake restarted (${reason})`),
      'restarted',
      ['group', 'ping']
    );
    this.handshakeReason = reason;
    this.helloAttempt = 0;
    this.helloBackoff.reset();
    this.sendHello();
  }

  private sendHello(): void {
    this.helloAttempt++;
    this.counters.add('handshakes');
    this.send(encodeHello());
    this.setState({
      kind: 'handshaking',
      reason: this.handshakeReason,
      attempt: this.helloAttempt,
    });
    this.armStateTimer(this.helloBackoff.next(), () => this.sendHello());
  }

  private onHelloAck(ack: HelloAck | ForeignHelloAck): void {
    if (this.current.kind !== 'handshaking') {
      return;
    }

    this.stopTimer(this.stateTimer);

    if (!isSupported(ack)) {
      this.fail(new Error(versionMismatch(ack.version)));
      return;
    }

    const previousBoot = this.info?.bootId;

    this.info = {
      protocolVersion: ack.version,
      schemaHash: ack.schemaHash,
      variableCount: ack.variableCount,
      loopTimeUs: ack.loopTimeUs,
      creditWindow: ack.creditWindow,
      bootId: ack.bootId,
      robotName: ack.robotName,
    };

    if (previousBoot === undefined) {
      this.beginTimeline('connected');
    } else if (previousBoot !== ack.bootId) {
      this.clock.reset();
      this.beginTimeline('reboot');
    }

    this.credit.reset(ack.creditWindow);
    this.groups.forgetRobotGroups();
    this.watchdog.start(now());
    this.applySchemaProgress(this.schemaLoader.begin(ack.schemaHash, ack.variableCount));
  }

  private applySchemaProgress(progress: SchemaProgress): void {
    switch (progress.kind) {
      case 'unchanged':
        this.groups.configure();
        break;
      case 'ready':
        this.adoptSchema(progress);
        break;
      case 'loading':
        this.setState({
          kind: 'loadingSchema',
          received: progress.received,
          total: progress.total,
        });
        this.armStateTimer(this.timing.schemaTimeoutMs, () => this.startHandshake('schema-retry'));
        break;
      case 'ignored':
        break;
    }
  }

  private adoptSchema(ready: Extract<SchemaProgress, { kind: 'ready' }>): void {
    this.stopTimer(this.stateTimer);

    if (this.adoptedHash !== undefined && this.adoptedHash !== ready.hash) {
      this.groups.dropLayout(new SessionError('restarted', 'The robot has a different schema now'));
    }

    this.adoptedHash = ready.hash;
    this.events.emit('schema', {
      hash: ready.hash,
      entries: ready.entries,
      fromCache: ready.fromCache,
    });
    this.groups.configure();
  }

  private beginTimeline(reason: TimelineEvent['reason']): void {
    this.timeline++;
    this.events.emit('timeline', { id: this.timeline, reason });
  }

  private onBytes(bytes: Uint8Array): void {
    const at = now();
    const frames = this.reader.push(bytes);

    this.counters.add('bytesIn', bytes.length);
    this.counters.add('framesDiscarded', this.reader.discarded - this.discardedSeen);
    this.discardedSeen = this.reader.discarded;

    if (frames.length > 0) {
      this.watchdog.heard(at);
    }

    for (const frame of frames) {
      this.counters.add('framesIn');

      if (isMetered(frame.type) && this.creditFlows()) {
        this.credit.received(wireSize(frame.payload.length), at);
      }

      this.dispatch(frame);
    }

    this.returnCredit();
  }

  private dispatch(frame: Frame): void {
    const message = decodeMessage(frame);

    if (!message) {
      this.counters.add('framesUndecodable');
      this.reportProtocolError(
        `Unreadable ${MessageType[frame.type] ?? `0x${frame.type.toString(16)}`} frame of ${frame.payload.length} bytes`
      );
      return;
    }

    this.handle(message);
  }

  private handle(message: RobotMessage): void {
    switch (message.type) {
      case MessageType.HELLO_ACK:
        this.onHelloAck(message);
        break;
      case MessageType.SCHEMA_PAGE:
        if (this.current.kind === 'loadingSchema') {
          this.applySchemaProgress(this.schemaLoader.accept(message));
        }
        break;
      case MessageType.GROUP_ACK:
        this.requests.resolve('group', message.group, message);
        break;
      case MessageType.SAMPLE:
        this.onSample(message);
        break;
      case MessageType.WRITE_ACK:
        this.requests.resolve('write', message.variableId, message.status);
        break;
      case MessageType.VALUE:
        this.requests.resolve('read', message.variableId, message.bytes);
        break;
      case MessageType.COMMAND_ACK:
        this.requests.resolve('command', message.code, commandReply(message));
        break;
      case MessageType.PONG:
        this.onPong(message);
        break;
      case MessageType.LOG:
        this.events.emit('log', {
          severity: message.severity,
          text: message.text,
          timeUs: this.clock.place(message.timestampUs),
        });
        break;
      case MessageType.ERROR:
        this.onRobotError(message.code, message.context);
        break;
    }
  }

  /**
   * Take a PONG as the barrier it is for the credit: every metered frame the robot sent before it
   * has arrived or never will. A total that no loss within the window explains, such as one below
   * what already arrived, means the count is off, whether the robot started over or not, and only
   * a new handshake sets it straight.
   */
  private onPong(pong: Pong): void {
    if (!this.requests.resolve('ping', 0, pong) || !this.creditFlows()) {
      return;
    }

    const recovered = this.credit.resync(pong.sentTotal, now());

    if (recovered === null) {
      this.startHandshake('credit-resync');
    } else {
      this.counters.add('creditRecovered', recovered);
    }
  }

  /**
   * Decode a sample into its epoch. A defined group only streams once enabled, and the robot
   * sends the GROUP_ACK of the enable ahead of the first sample, so a sample of an epoch not yet
   * announced announces it: its acknowledgement came first on the wire, even when the configurator
   * waiting for it has not run yet.
   */
  private onSample(sample: Sample): void {
    if (this.current.kind !== 'configuring' && this.current.kind !== 'streaming') {
      return;
    }

    const at = now();
    const timeUs = this.unwrapTimestamp(sample.timestampUs, at);
    const open = this.epochs.current(sample.group);

    if (!open) {
      this.groups.noteStrayGroup(sample.group);
      return;
    }

    this.epochs.activate(sample.group);

    const missing = open.advance(sample.seq);
    const values = open.decode(sample.values);

    if (missing > 0) {
      this.counters.add('droppedSamples', missing);
      this.events.emit('dropped', { epoch: open.epoch.id, count: missing });
    }

    if (!values) {
      this.reportProtocolError(
        `A sample of group ${sample.group} has ${sample.values.length} bytes; ${open.epoch.sampleSize} were acknowledged`
      );
      return;
    }

    this.counters.add('samples');
    this.watchdog.sampled(at);
    this.events.emit('sample', {
      epoch: open.epoch.id,
      seq: sample.seq,
      timeUs,
      values,
      missingBefore: missing,
    });
  }

  /**
   * Unwrap a timestamp, and move the streams onto a new timeline when it shows the robot's clock
   * starting over.
   */
  private unwrapTimestamp(timestampUs: number, at: number): number {
    const resets = this.clock.resets;
    const timeUs = this.clock.unwrap(timestampUs, at);

    if (this.clock.resets !== resets) {
      this.counters.set('clockResets', this.clock.resets);
      this.beginTimeline('clock-reset');
      this.epochs.moveToTimeline(this.timeline);
    }

    return timeUs;
  }

  private onRobotError(code: ErrorCode, context: number): void {
    if (!this.requests.refuse(code, context)) {
      this.reportProtocolError(
        `The robot sent ${ErrorCode[code] ?? code} (${context})`,
        code,
        context
      );
    }
  }

  private onEpochOpened(epoch: Epoch): void {
    this.activeEpochs = null;
    this.watchdog.sampled(now());
    this.events.emit('epoch', epoch);
  }

  private onEpochEnded(epoch: Epoch, reason: EpochEndReason): void {
    this.activeEpochs = null;
    this.events.emit('epochEnd', { epoch, reason });
  }

  private streamingPeriodMs(): number | null {
    const epochs = this.openEpochs;

    if (this.current.kind !== 'streaming' || epochs.length === 0) {
      return null;
    }

    const fastest = Math.min(...epochs.map((epoch) => epoch.periodTicks));
    return (fastest * (this.info?.loopTimeUs ?? 0)) / 1000;
  }

  private creditFlows(): boolean {
    return LINK_UP_STATES.has(this.current.kind) && this.transport.state.kind === 'open';
  }

  private returnCredit(): void {
    this.stopTimer(this.creditTimer);

    if (!this.creditFlows()) {
      return;
    }

    const at = now();
    const grant = this.credit.take(at);

    if (grant) {
      this.send(encodeCredit(grant.payload));
      this.counters.add('creditReturned', grant.bytes);
    }

    const dueAt = this.credit.dueAt();

    if (dueAt !== null) {
      this.creditTimer = setTimeout(() => this.returnCredit(), Math.max(0, dueAt - at));
    }
  }

  private startStats(): void {
    this.stopStats();
    this.statsTimer = setInterval(
      () => this.events.emit('stats', this.stats),
      this.timing.statsIntervalMs
    );
  }

  private stopStats(): void {
    clearInterval(this.statsTimer);
    this.statsTimer = undefined;
  }

  private fail(error: Error): void {
    this.stopActivity(error, 'restarted');
    this.groups.rejectWaiters(error);
    this.setState({ kind: 'error', error });
  }

  /**
   * Stop everything the current handshake started: timers, the robot's groups and credit, and
   * the requests that depend on them.
   *
   * @param error What the requests fail with.
   * @param reason Why the open epochs end.
   * @param kinds The requests to fail; every one, writes held back included, when left out.
   */
  private stopActivity(error: Error, reason: EpochEndReason, kinds?: readonly RequestKind[]): void {
    this.generation++;
    this.stopTimer(this.stateTimer);
    this.stopTimer(this.creditTimer);
    this.watchdog.stop();

    if (!kinds) {
      this.writes.failHeld(error);
    }

    this.requests.rejectAll(error, kinds);
    this.epochs.endAll(reason);
    this.credit.reset();
  }

  private armStateTimer(delayMs: number, action: () => void): void {
    this.stopTimer(this.stateTimer);
    this.stateTimer = setTimeout(action, delayMs);
  }

  private stopTimer(timer: Timer | undefined): void {
    clearTimeout(timer);
  }

  private requireEntry(variableId: number): SchemaEntry {
    const schema = this.schema;

    if (!LINK_UP_STATES.has(this.current.kind) || !schema) {
      throw this.notReady();
    }

    const entry = schema[variableId] as SchemaEntry | undefined;

    if (!entry) {
      throw new Error(`No variable ${variableId} in the schema`);
    }

    return entry;
  }

  private notReady(): SessionError {
    return new SessionError('not-ready', `The session is ${this.current.kind}`);
  }

  private send(frame: Uint8Array): void {
    if (this.transport.state.kind !== 'open') {
      return;
    }

    this.transport.send(frame);
    this.counters.add('bytesOut', frame.length);
  }

  private setState(state: SessionState): void {
    this.current = state;
    this.events.emit('state', state);
  }

  private reportProtocolError(message: string, code?: ErrorCode, context?: number): void {
    this.events.emit('protocolError', { message, code, context });
  }
}

function versionMismatch(version: number): string {
  const update = version < PROTOCOL_VERSION ? "the robot's firmware" : 'this monitor';

  return `The robot speaks version ${version} of the link protocol and this monitor speaks version ${PROTOCOL_VERSION}; update ${update} to connect`;
}

function commandReply(ack: CommandAck): CommandReply {
  return ack.reason === 0 ? { result: ack.result } : { result: ack.result, reason: ack.reason };
}

function now(): number {
  return performance.now();
}

function decodeReadValue(entry: SchemaEntry, bytes: Uint8Array): ReadResult {
  if (entry.type === TypeCode.BLOB) {
    return bytes.slice();
  }

  const value = readValue(bytes, 0, entry.type);

  if (value === null) {
    throw new Error(`The value of ${entry.name} has ${bytes.length} bytes, too few for its type`);
  }

  return value;
}
