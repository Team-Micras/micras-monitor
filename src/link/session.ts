import {
  ErrorCode,
  FrameReader,
  MAX_GROUPS,
  MessageType,
  PROTOCOL_VERSION,
  readValue,
  TypeCode,
  validateValue,
  writeValue,
  WriteStatus,
  type Frame,
  type Fundamental,
} from '../protocol';
import { TimestampUnwrapper } from './clock';
import { CoalescingCredit, isMetered, wireSize, type CreditPolicy } from './credit';
import { Emitter, type Listener, type Unsubscribe } from './emitter';
import { SessionError, TimeoutError } from './errors';
import {
  EpochRegistry,
  planGroups,
  sameLayout,
  type Epoch,
  type GroupLayout,
  type GroupRequest,
} from './groups';
import {
  CommandResult,
  decodeMessage,
  encodeCommand,
  encodeCredit,
  encodeGroupDefine,
  encodeGroupEnable,
  encodeHello,
  encodePing,
  encodeRead,
  encodeSchemaRequest,
  encodeWrite,
  type GroupAck,
  type HelloAck,
  type RobotMessage,
  type Sample,
  type SchemaPage,
} from './messages';
import { PendingRequests, type ErrorMatcher, type RequestKind } from './requests';
import { MemorySchemaCache, SchemaAssembler, type SchemaCache, type SchemaEntry } from './schema';
import {
  DEFAULT_TIMING,
  type HandshakeReason,
  type LinkStats,
  type ReadResult,
  type RobotInfo,
  type SessionEvents,
  type SessionState,
  type SessionTiming,
} from './session-types';
import { asError, type Transport } from './transport';

/** What a session is built from; everything has a default. */
export interface SessionOptions {
  /** Where schemas are kept between sessions; in memory by default. */
  schemaCache?: SchemaCache;

  /** When to give credit back; protocol version 1's coalesced delta by default. */
  creditPolicy?: CreditPolicy;

  /** Timeouts and periods, over the defaults for a radio link. */
  timing?: Partial<SessionTiming>;
}

type Timer = ReturnType<typeof setTimeout>;

interface GroupsWaiter {
  layouts: readonly GroupLayout[];
  resolve: (epochs: Epoch[]) => void;
  reject: (error: Error) => void;
}

interface PendingWrite {
  value: Fundamental;
  token: symbol;
}

const LINK_UP_STATES = new Set<SessionState['kind']>(['loadingSchema', 'configuring', 'streaming']);

/**
 * A session with one robot over one transport: the handshake, the schema, the stream groups,
 * the credit window and every request with its answer.
 *
 * It is a state machine driven by the bytes the transport pushes and by its own timers, and it
 * reports through typed events. It recovers on its own from what a radio link does: pages and
 * answers that go missing, credit that is lost with a corrupted frame, a robot that reboots or
 * goes silent.
 */
export class Session {
  private readonly events = new Emitter<SessionEvents>();
  private readonly reader = new FrameReader();
  private readonly requests = new PendingRequests();
  private readonly epochs = new EpochRegistry();
  private readonly clock = new TimestampUnwrapper();
  private readonly enabled = new Set<number>();
  private readonly pendingWrites = new Map<number, PendingWrite>();
  private readonly credit: CreditPolicy;
  private readonly cache: SchemaCache;
  private readonly timing: SessionTiming;
  private readonly detach: Unsubscribe[];

  private current: SessionState = { kind: 'disconnected' };
  private info: RobotInfo | undefined;
  private schemaHash: number | undefined;
  private entries: readonly SchemaEntry[] | undefined;
  private assembler: SchemaAssembler | undefined;
  private gapRequestedFrom = -1;
  private schemaRequests = 0;
  private helloAttempts = 0;
  private handshakeReason: HandshakeReason = 'connected';
  private desired: readonly GroupLayout[] = [];
  private waiters: GroupsWaiter[] = [];
  private configuringGeneration: number | null = null;
  private configurePending = false;
  private generation = 0;
  private lastSampleAt = 0;
  private lastHeardAt = 0;
  private discardedSeen = 0;
  private counters: Mutable<LinkStats> = emptyStats();

  private stateTimer: Timer | undefined;
  private creditTimer: Timer | undefined;
  private keepaliveTimer: ReturnType<typeof setInterval> | undefined;
  private stallTimer: ReturnType<typeof setInterval> | undefined;
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
    this.credit = options.creditPolicy ?? new CoalescingCredit();
    this.cache = options.schemaCache ?? new MemorySchemaCache();
    this.timing = { ...DEFAULT_TIMING, ...options.timing };
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

  /** The robot's schema, once known. */
  get schema(): readonly SchemaEntry[] | undefined {
    return this.entries;
  }

  /** The epochs samples are arriving for. */
  get openEpochs(): Epoch[] {
    return this.epochs.all().filter((epoch) => this.enabled.has(epoch.group));
  }

  /** The counters of the link. */
  get stats(): LinkStats {
    return { ...this.counters, clockResets: this.clock.resets };
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

    this.stopActivity(closed);
    this.stopTimer(this.statsTimer);
    this.rejectWaiters(closed);
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
   * layout, and the promise fails with the reason once every other group was applied.
   *
   * @param requests The groups, at most `MAX_GROUPS`.
   * @returns The epochs streaming once the robot acknowledged the whole layout.
   */
  setGroups(requests: readonly GroupRequest[]): Promise<Epoch[]> {
    if (this.current.kind === 'closed') {
      return Promise.reject(new SessionError('closed'));
    }

    if (this.current.kind === 'error') {
      return Promise.reject(this.notReady());
    }

    if (!this.entries) {
      return Promise.reject(new SessionError('not-ready', 'The schema is not known yet'));
    }

    let layouts: GroupLayout[];

    try {
      layouts = planGroups(this.entries, requests);
    } catch (error) {
      return Promise.reject(asError(error));
    }

    this.rejectWaiters(new SessionError('superseded', 'A later layout replaced this one'));
    this.desired = layouts;

    const done = new Promise<Epoch[]>((resolve, reject) => {
      this.waiters.push({ layouts, resolve, reject });
    });

    if (this.current.kind === 'configuring' || this.current.kind === 'streaming') {
      void this.configure();
    }

    return done;
  }

  /**
   * Write a variable.
   *
   * The value is pending until the robot acknowledges it; `pendingWrite` and the `write` event
   * say so, and neither ever reports it confirmed before the WRITE_ACK.
   *
   * @param variableId The variable.
   * @param value Its new value, which has to fit its type.
   * @returns What the robot answered.
   */
  async write(variableId: number, value: Fundamental): Promise<WriteStatus> {
    const entry = this.requireEntry(variableId);

    if (entry.type === TypeCode.BLOB) {
      throw new Error(`${entry.name} is a blob; only primitives can be written`);
    }

    validateValue(value, entry.type);

    const token = Symbol(entry.name);
    this.pendingWrites.set(variableId, { value, token });
    const answer = this.requests.add(
      'write',
      variableId,
      this.timing.requestTimeoutMs,
      answersWith(ErrorCode.MALFORMED, variableId)
    );
    this.events.emit('write', { variableId, value, state: 'pending' });
    this.send(encodeWrite(variableId, writeValue(value, entry.type)));

    try {
      const status = await answer;
      this.events.emit(
        'write',
        status === WriteStatus.OK
          ? { variableId, value, state: 'confirmed' }
          : { variableId, value, state: 'refused', status }
      );
      return status;
    } catch (error) {
      this.events.emit('write', { variableId, value, state: 'failed', error: asError(error) });
      throw error;
    } finally {
      if (this.pendingWrites.get(variableId)?.token === token) {
        this.pendingWrites.delete(variableId);
      }
    }
  }

  /**
   * The value of the latest write to a variable that the robot has not answered yet.
   */
  pendingWrite(variableId: number): Fundamental | undefined {
    return this.pendingWrites.get(variableId)?.value;
  }

  /**
   * Read the current value of a variable, streamed or not.
   *
   * @param variableId The variable.
   * @returns Its value, or the bytes of a blob.
   */
  async read(variableId: number): Promise<ReadResult> {
    const entry = this.requireEntry(variableId);

    const answer = this.requests.add(
      'read',
      variableId,
      this.timing.requestTimeoutMs,
      (code, context) =>
        (code === ErrorCode.NO_SUCH_VARIABLE || code === ErrorCode.GROUP_TOO_LARGE) &&
        context === variableId
    );
    this.send(encodeRead(variableId));

    const bytes = await answer;
    const value = decodeReadValue(entry, bytes);

    this.events.emit('value', { variableId, value });
    return value;
  }

  /**
   * Ask the robot to act once.
   *
   * @param code The command, as the robot numbers them.
   * @param argument Whatever the command takes, as a u32.
   * @returns What the robot answered.
   */
  command(code: number, argument = 0): Promise<CommandResult> {
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
      answersWith(ErrorCode.MALFORMED, code)
    );
    this.send(encodeCommand(code, argument));
    return answer;
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
      this.stopActivity(new SessionError('disconnected', 'The transport closed'));
      this.stopTimer(this.statsTimer);
      this.reader.clear();
      this.setState({ kind: 'disconnected' });
    }
  }

  private startHandshake(reason: HandshakeReason): void {
    this.stopActivity(new SessionError('restarted', `The handshake restarted (${reason})`), [
      'group',
      'ping',
    ]);
    this.handshakeReason = reason;
    this.helloAttempts = 0;

    if (reason !== 'schema-retry') {
      this.schemaRequests = 0;
    }

    this.sendHello();
  }

  private sendHello(): void {
    if (this.helloAttempts >= this.timing.helloAttempts) {
      this.fail(new Error(`The robot did not answer ${this.helloAttempts} HELLOs`));
      return;
    }

    this.helloAttempts++;
    this.counters.handshakes++;
    this.send(encodeHello());
    this.setState({
      kind: 'handshaking',
      reason: this.handshakeReason,
      attempt: this.helloAttempts,
    });
    this.armStateTimer(this.timing.helloTimeoutMs, () => this.sendHello());
  }

  private onHelloAck(ack: HelloAck): void {
    if (this.current.kind !== 'handshaking') {
      return;
    }

    this.stopTimer(this.stateTimer);

    if (ack.version !== PROTOCOL_VERSION) {
      this.fail(
        new Error(
          `The robot speaks protocol ${ack.version}; this monitor speaks ${PROTOCOL_VERSION}`
        )
      );
      return;
    }

    this.info = {
      protocolVersion: ack.version,
      schemaHash: ack.schemaHash,
      variableCount: ack.variableCount,
      loopTimeUs: ack.loopTimeUs,
      initialCredit: ack.initialCredit,
    };
    this.startKeepalive();

    if (this.schemaHash === ack.schemaHash && this.entries?.length === ack.variableCount) {
      void this.configure();
      return;
    }

    const cached = this.loadCachedSchema(ack.schemaHash);

    if (cached?.length === ack.variableCount) {
      this.adoptSchema(ack.schemaHash, cached, true);
      void this.configure();
      return;
    }

    this.loadSchema(ack);
  }

  private loadSchema(ack: HelloAck): void {
    const assembler = this.assembler;

    if (assembler?.hash !== ack.schemaHash || assembler.total !== ack.variableCount) {
      this.assembler = new SchemaAssembler(ack.schemaHash, ack.variableCount);
      this.schemaRequests = 0;
    }

    if (this.schemaRequests >= this.timing.schemaAttempts) {
      this.fail(new Error(`The schema did not arrive after ${this.schemaRequests} requests`));
      return;
    }

    this.schemaRequests++;
    this.gapRequestedFrom = -1;
    this.requestSchemaFromFirstMissing();
  }

  private requestSchemaFromFirstMissing(): void {
    const assembler = this.assembler;

    if (!assembler) {
      return;
    }

    this.send(encodeSchemaRequest(assembler.firstMissing));
    this.showSchemaProgress(assembler);
  }

  private onSchemaPage(page: SchemaPage): void {
    const assembler = this.assembler;

    if (this.current.kind !== 'loadingSchema' || !assembler) {
      return;
    }

    const outcome = assembler.accept(page);

    if (outcome === 'ignored') {
      return;
    }

    this.schemaRequests = 0;

    if (outcome === 'complete') {
      this.stopTimer(this.stateTimer);
      this.assembler = undefined;
      this.adoptSchema(assembler.hash, assembler.result(), false);
      void this.configure();
      return;
    }

    if (outcome === 'gap') {
      this.askAgainAfterGap(assembler);
      return;
    }

    this.gapRequestedFrom = -1;

    this.showSchemaProgress(assembler);
  }

  /**
   * Pages the robot sent before it saw the new request still arrive after the same gap, and must
   * not each trigger a request of their own.
   */
  private askAgainAfterGap(assembler: SchemaAssembler): void {
    if (assembler.firstMissing === this.gapRequestedFrom) {
      this.showSchemaProgress(assembler);
      return;
    }

    this.gapRequestedFrom = assembler.firstMissing;
    this.requestSchemaFromFirstMissing();
  }

  private showSchemaProgress(assembler: SchemaAssembler): void {
    this.setState({ kind: 'loadingSchema', received: assembler.received, total: assembler.total });
    this.armStateTimer(this.timing.schemaTimeoutMs, () => this.startHandshake('schema-retry'));
  }

  private adoptSchema(hash: number, entries: readonly SchemaEntry[], fromCache: boolean): void {
    if (this.schemaHash !== undefined && this.schemaHash !== hash) {
      this.desired = [];
      this.rejectWaiters(new SessionError('restarted', 'The robot has a different schema now'));
    }

    this.schemaHash = hash;
    this.entries = entries;

    if (!fromCache) {
      this.storeCachedSchema(hash, entries);
    }

    this.events.emit('schema', { hash, entries, fromCache });
  }

  private loadCachedSchema(hash: number): readonly SchemaEntry[] | undefined {
    try {
      return this.cache.load(hash);
    } catch (error) {
      this.reportProtocolError(`Reading the schema cache failed: ${asError(error).message}`);
      return undefined;
    }
  }

  private storeCachedSchema(hash: number, entries: readonly SchemaEntry[]): void {
    try {
      this.cache.store(hash, entries);
    } catch (error) {
      this.reportProtocolError(`Keeping the schema in the cache failed: ${asError(error).message}`);
    }
  }

  private async configure(): Promise<void> {
    this.configurePending = true;

    if (this.configuringGeneration === this.generation) {
      return;
    }

    const generation = this.generation;
    this.configuringGeneration = generation;

    try {
      await this.applyWhilePending(generation);
    } finally {
      if (this.configuringGeneration === generation) {
        this.configuringGeneration = null;
      }
    }
  }

  private async applyWhilePending(generation: number): Promise<void> {
    if (!this.configurePending || generation !== this.generation) {
      return;
    }

    this.configurePending = false;
    await this.applyDesired(generation);
    return this.applyWhilePending(generation);
  }

  private async applyDesired(generation: number): Promise<void> {
    const layouts = this.desired;
    const failures: Error[] = [];

    if (layouts.length > 0 || this.enabled.size > 0) {
      this.setState({ kind: 'configuring' });
    }

    await this.applyGroupsFrom(0, layouts, generation, failures);

    if (generation !== this.generation) {
      return;
    }

    if (failures.length > 0) {
      this.desired = layouts.filter((layout) => this.enabled.has(layout.group));
    }

    if (!this.configurePending) {
      this.setState({ kind: 'streaming' });
      this.startStallWatch();
    }

    this.settleWaiters(layouts, failures[0]);
    failures.forEach((failure) =>
      this.reportProtocolError(`Configuring the groups failed: ${failure.message}`)
    );
  }

  private async applyGroupsFrom(
    group: number,
    layouts: readonly GroupLayout[],
    generation: number,
    failures: Error[]
  ): Promise<void> {
    if (group >= MAX_GROUPS || generation !== this.generation) {
      return;
    }

    try {
      await this.applyGroup(
        group,
        layouts.find((layout) => layout.group === group),
        generation
      );
    } catch (error) {
      failures.push(asError(error));
    }

    return this.applyGroupsFrom(group + 1, layouts, generation, failures);
  }

  private async applyGroup(
    group: number,
    layout: GroupLayout | undefined,
    generation: number
  ): Promise<void> {
    const current = this.epochs.current(group);

    if (layout && current && this.enabled.has(group) && sameLayout(layout, current.epoch)) {
      return;
    }

    if (!layout) {
      await this.disableGroup(group, generation);
      return;
    }

    this.enabled.delete(group);

    try {
      await this.defineGroup(layout, generation);
      await this.groupRequest(encodeGroupEnable(group, true), group, noSuchGroup(group));
      this.throwIfRestarted(generation);
    } catch (error) {
      if (generation === this.generation) {
        this.epochs.end(group);
      }

      throw error;
    }

    this.enabled.add(group);
    this.lastSampleAt = now();
  }

  private async disableGroup(group: number, generation: number): Promise<void> {
    if (this.enabled.has(group)) {
      await this.groupRequest(encodeGroupEnable(group, false), group, noSuchGroup(group));
      this.throwIfRestarted(generation);
    }

    this.enabled.delete(group);
    this.epochs.end(group);
  }

  private async defineGroup(layout: GroupLayout, generation: number): Promise<void> {
    const ack = await this.groupRequest(
      encodeGroupDefine(layout.group, layout.periodTicks, layout.variableIds),
      layout.group,
      answersDefine(layout)
    );
    this.throwIfRestarted(generation);

    if (ack.sampleSize !== layout.sampleSize) {
      throw new Error(
        `The robot acknowledged ${ack.sampleSize} bytes for group ${layout.group}; the schema adds up to ${layout.sampleSize}`
      );
    }

    const opened = this.epochs.begin(layout, ack.periodTicks, ack.sampleSize);
    this.events.emit('epoch', opened.epoch);
  }

  private async groupRequest(
    frame: Uint8Array,
    group: number,
    answersError: ErrorMatcher,
    attempt = 1
  ): Promise<GroupAck> {
    const answer = this.requests.add('group', group, this.timing.requestTimeoutMs, answersError);
    this.send(frame);

    try {
      return await answer;
    } catch (error) {
      if (!(error instanceof TimeoutError) || attempt >= this.timing.groupAttempts) {
        throw error;
      }

      return this.groupRequest(frame, group, answersError, attempt + 1);
    }
  }

  private throwIfRestarted(generation: number): void {
    if (generation !== this.generation) {
      throw new SessionError('restarted');
    }
  }

  private settleWaiters(layouts: readonly GroupLayout[], error?: Error): void {
    const settled = this.waiters.filter((waiter) => waiter.layouts === layouts);
    this.waiters = this.waiters.filter((waiter) => waiter.layouts !== layouts);

    for (const waiter of settled) {
      if (error) {
        waiter.reject(error);
      } else {
        waiter.resolve(this.openEpochs);
      }
    }
  }

  private rejectWaiters(error: Error): void {
    const waiters = this.waiters;
    this.waiters = [];
    waiters.forEach((waiter) => waiter.reject(error));
  }

  private onBytes(bytes: Uint8Array): void {
    this.counters.bytesIn += bytes.length;

    const frames = this.reader.push(bytes);
    const at = now();

    this.counters.framesDiscarded += this.reader.discarded - this.discardedSeen;
    this.discardedSeen = this.reader.discarded;

    if (frames.length > 0) {
      this.lastHeardAt = at;
    }

    for (const frame of frames) {
      this.counters.framesIn++;

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
        this.onSchemaPage(message);
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
        this.requests.resolve('command', message.code, message.result);
        break;
      case MessageType.PONG:
        this.requests.resolve('ping', 0, undefined);
        break;
      case MessageType.LOG:
        this.events.emit('log', { severity: message.severity, text: message.text });
        break;
      case MessageType.ERROR:
        this.onRobotError(message.code, message.context);
        break;
    }
  }

  private onSample(sample: Sample): void {
    const open = this.epochs.current(sample.group);

    if (!open) {
      return;
    }

    const missing = open.advance(sample.seq);
    const values = open.decode(sample.values);

    if (missing > 0) {
      this.counters.droppedSamples += missing;
      this.events.emit('dropped', { epoch: open.epoch.id, count: missing });
    }

    if (!values) {
      this.reportProtocolError(
        `A sample of group ${sample.group} has ${sample.values.length} bytes; ${open.epoch.sampleSize} were acknowledged`
      );
      return;
    }

    this.counters.samples++;
    this.lastSampleAt = now();
    this.events.emit('sample', {
      epoch: open.epoch.id,
      seq: sample.seq,
      timeUs: this.clock.unwrap(sample.timestampUs),
      values,
    });
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

  private creditFlows(): boolean {
    return LINK_UP_STATES.has(this.current.kind) && this.transport.state.kind === 'open';
  }

  private returnCredit(): void {
    this.stopTimer(this.creditTimer);

    if (!this.creditFlows()) {
      return;
    }

    const at = now();
    const delta = this.credit.take(at);

    if (delta !== null) {
      this.send(encodeCredit(delta));
      this.counters.creditReturned += delta;
    }

    const dueAt = this.credit.dueAt();

    if (dueAt !== null) {
      this.creditTimer = setTimeout(() => this.returnCredit(), Math.max(0, dueAt - at));
    }
  }

  private startKeepalive(): void {
    this.stopTimer(this.keepaliveTimer);
    this.lastHeardAt = now();
    this.keepaliveTimer = setInterval(() => this.keepAlive(), this.timing.pingIntervalMs);
  }

  private keepAlive(): void {
    if (now() - this.lastHeardAt > this.timing.silenceTimeoutMs) {
      this.startHandshake('keepalive');
    } else if (!this.requests.has('ping')) {
      this.ping();
    }
  }

  private ping(): void {
    const sentAt = now();
    const answer = this.requests.add('ping', 0, this.timing.pingIntervalMs / 2);

    this.send(encodePing());
    answer.then(
      () => {
        this.counters.rttMs = now() - sentAt;
      },
      () => undefined
    );
  }

  private startStallWatch(): void {
    this.stopTimer(this.stallTimer);
    this.stallTimer = setInterval(
      () => this.checkForStall(),
      Math.max(50, this.timing.minStallMs / 4)
    );
  }

  private checkForStall(): void {
    if (this.current.kind !== 'streaming' || this.enabled.size === 0) {
      return;
    }

    if (now() - this.lastSampleAt > this.stallTimeoutMs()) {
      this.startHandshake('stall');
    }
  }

  private stallTimeoutMs(): number {
    const fastest = Math.min(...this.openEpochs.map((epoch) => epoch.periodTicks));
    const periodMs = (fastest * (this.info?.loopTimeUs ?? 0)) / 1000;
    return Math.max(this.timing.minStallMs, this.timing.stallPeriods * periodMs);
  }

  private startStats(): void {
    this.stopTimer(this.statsTimer);
    this.statsTimer = setInterval(
      () => this.events.emit('stats', this.stats),
      this.timing.statsIntervalMs
    );
  }

  private fail(error: Error): void {
    this.stopActivity(error);
    this.rejectWaiters(error);
    this.setState({ kind: 'error', error });
  }

  /**
   * Stop everything the current handshake started: timers, the robot's groups and credit, and
   * the requests that depend on them.
   */
  private stopActivity(error: Error, kinds?: readonly RequestKind[]): void {
    this.generation++;
    this.stopTimer(this.stateTimer);
    this.stopTimer(this.creditTimer);
    this.stopTimer(this.keepaliveTimer);
    this.stopTimer(this.stallTimer);
    this.requests.rejectAll(error, kinds);
    this.epochs.endAll();
    this.enabled.clear();
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
    if (!LINK_UP_STATES.has(this.current.kind) || !this.entries) {
      throw this.notReady();
    }

    const entry = this.entries[variableId] as SchemaEntry | undefined;

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
    this.counters.bytesOut += frame.length;
  }

  private setState(state: SessionState): void {
    this.current = state;
    this.events.emit('state', state);
  }

  private reportProtocolError(message: string, code?: ErrorCode, context?: number): void {
    this.events.emit('protocolError', { message, code, context });
  }
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

function emptyStats(): Mutable<LinkStats> {
  return {
    bytesIn: 0,
    bytesOut: 0,
    framesIn: 0,
    framesDiscarded: 0,
    creditReturned: 0,
    rttMs: null,
    samples: 0,
    droppedSamples: 0,
    handshakes: 0,
    clockResets: 0,
  };
}

function now(): number {
  return performance.now();
}

function answersWith(code: ErrorCode, context: number): ErrorMatcher {
  return (actual, actualContext) => actual === code && actualContext === context;
}

function noSuchGroup(group: number): ErrorMatcher {
  return answersWith(ErrorCode.NO_SUCH_GROUP, group);
}

function answersDefine(layout: GroupLayout): ErrorMatcher {
  return (code, context) => {
    switch (code) {
      case ErrorCode.NO_SUCH_GROUP:
        return context === layout.group;
      case ErrorCode.GROUP_TOO_LARGE:
        return true;
      case ErrorCode.NOT_STREAMABLE:
      case ErrorCode.NO_SUCH_VARIABLE:
        return layout.variableIds.includes(context);
      default:
        return false;
    }
  };
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
