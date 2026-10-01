import { Emitter, type Listener, type Unsubscribe } from '@/core/emitter';

import type { Transport } from '../transports/transport';
import {
  ErrorCode,
  FrameReader,
  MessageType,
  TypeCode,
  validateValue,
  writeValue,
  type WireValue,
} from '../wire';
import { CreditFlow } from './credit';
import { decodeReadValue, EpochRegistry, type Epoch, type EpochEndReason } from './epochs';
import { LinkError } from './errors';
import { GroupConfigurator, type GroupRequest } from './group-configurator';
import {
  DEFAULT_TIMING,
  LinkTally,
  type GroupsResult,
  type HandshakeReason,
  type LinkContext,
  type LinkCounters,
  type LinkEvents,
  type LinkState,
  type LinkTiming,
  type ReadResult,
  type RobotInfo,
  type WriteResult,
} from './link-events';
import { LinkWatchdog } from './link-watchdog';
import {
  decodeMessage,
  encodeCommand,
  encodeHello,
  encodeRead,
  isSupported,
  unsupportedVersion,
  type CommandReply,
  type ForeignHelloAck,
  type HelloAck,
  type RobotMessage,
  type Sample,
} from './messages';
import { AsyncMutex, PendingRequests, type RequestKind } from './requests';
import { Backoff } from './retry';
import {
  MemorySchemaCache,
  SchemaLoader,
  type SchemaCache,
  type SchemaEntry,
  type SchemaProgress,
} from './schema';
import { WriteQueue } from './write-queue';

/** What a link is built from; everything has a default. */
export interface RobotLinkOptions {
  /** Where schemas are kept between connections; in memory by default. */
  schemaCache?: SchemaCache;

  /** Timeouts and periods, over the defaults for a radio link. */
  timing?: Partial<LinkTiming>;
}

const LINK_UP_STATES = new Set<LinkState['kind']>(['loadingSchema', 'configuring', 'streaming']);

/**
 * The link to one robot over one transport: the handshake, the schema, the stream groups,
 * the credit window and every request with its answer.
 *
 * It is a state machine driven by the bytes the transport pushes and by its own timers, and it
 * reports through typed events. It recovers on its own from what a radio link does: pages and
 * answers that go missing, credit that is lost with a corrupted frame, a robot that reboots or
 * goes silent. While the transport is open it never gives up on the robot; only what retrying
 * cannot fix, such as another protocol version, ends in `error`.
 */
export class RobotLink {
  readonly #transport: Transport;
  readonly #events = new Emitter<LinkEvents>();
  readonly #reader = new FrameReader();
  readonly #requests = new PendingRequests();
  readonly #counters = new LinkTally();
  readonly #sizeRefusals = new AsyncMutex();
  readonly #timing: LinkTiming;
  readonly #helloBackoff: Backoff;
  readonly #context: LinkContext;
  readonly #credit: CreditFlow;
  readonly #schemaLoader: SchemaLoader;
  readonly #epochs: EpochRegistry;
  readonly #groups: GroupConfigurator;
  readonly #watchdog: LinkWatchdog;
  readonly #writes: WriteQueue;
  readonly #detach: Unsubscribe[];

  #state: LinkState = { kind: 'disconnected' };
  #info: RobotInfo | undefined;
  #adoptedHash: number | undefined;
  #handshakeReason: HandshakeReason = 'connected';
  #helloAttempt = 0;
  #generation = 0;
  #discardedSeen = 0;
  #stateTimer: ReturnType<typeof setTimeout> | undefined;

  /**
   * @param transport The byte pipe to the robot. The link starts its handshake as soon as the
   * transport is open, and closes it when the link is closed.
   * @param options What the link is built from.
   */
  constructor(transport: Transport, options: RobotLinkOptions = {}) {
    this.#transport = transport;
    this.#timing = { ...DEFAULT_TIMING, ...options.timing };
    this.#helloBackoff = new Backoff({
      initialMs: this.#timing.helloTimeoutMs,
      maxMs: this.#timing.helloBackoffMaxMs,
      factor: 2,
    });
    this.#context = {
      timing: this.#timing,
      requests: this.#requests,
      counters: this.#counters,
      generation: () => this.#generation,
      send: (frame) => this.#send(frame),
      emit: (event, payload) => this.#events.emit(event, payload),
      report: (message, code, context) =>
        this.#events.emit('protocolError', { message, code, context }),
    };
    this.#credit = new CreditFlow(this.#context);
    this.#schemaLoader = new SchemaLoader(
      options.schemaCache ?? new MemorySchemaCache(),
      this.#context
    );
    this.#epochs = new EpochRegistry(this.#context);
    this.#groups = new GroupConfigurator(this.#context, this.#epochs, this.#sizeRefusals, (busy) =>
      this.#setState({ kind: busy ? 'configuring' : 'streaming' })
    );
    this.#watchdog = new LinkWatchdog(
      this.#context,
      () =>
        this.#state.kind === 'streaming'
          ? this.#epochs.fastestPeriodMs(this.#info?.loopTimeUs ?? 0)
          : null,
      (reason) => this.#startHandshake(reason)
    );
    this.#writes = new WriteQueue(this.#context);
    this.#detach = [
      this.#events.on('epoch', () => this.#watchdog.sampled(performance.now())),
      transport.onBytes((bytes) => this.#onBytes(bytes)),
      transport.onState(() => this.#onTransportState()),
    ];
    this.#onTransportState();
  }

  /** Where the link is now. */
  get state(): LinkState {
    return this.#state;
  }

  /** What the last HELLO_ACK said about the robot. */
  get robot(): RobotInfo | undefined {
    return this.#info;
  }

  /** The robot's schema, once known; unknown again while a different one loads. */
  get schema(): readonly SchemaEntry[] | undefined {
    return this.#schemaLoader.schema;
  }

  /** The epochs samples are arriving for, by group. The same array until one begins or ends. */
  get openEpochs(): readonly Epoch[] {
    return this.#epochs.active();
  }

  /** The counters of the link. The same object until one of them changes. */
  get stats(): LinkCounters {
    return this.#counters.snapshot;
  }

  /**
   * Listen to an event.
   *
   * @returns A function that removes the listener.
   */
  on<K extends keyof LinkEvents>(event: K, listener: Listener<LinkEvents[K]>): Unsubscribe {
    return this.#events.on(event, listener);
  }

  /** Open the transport, which starts the handshake. */
  open(): void {
    if (this.#state.kind !== 'closed') {
      this.#transport.open();
    }
  }

  /** End the link and close the transport. Every pending request fails. */
  close(): void {
    if (this.#state.kind === 'closed') {
      return;
    }

    const closed = new LinkError('closed', 'The link was closed');

    this.#stopActivity(closed, 'disconnected');
    this.#counters.stopReporting();
    this.#groups.rejectWaiters(closed);
    this.#detach.forEach((unsubscribe) => unsubscribe());
    this.#transport.close();
    this.#setState({ kind: 'closed' });
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
    if (this.#state.kind === 'closed') {
      return Promise.reject(new LinkError('closed'));
    }

    if (this.#state.kind === 'error') {
      return Promise.reject(this.#notReady());
    }

    const schema = this.schema;

    if (!schema) {
      return Promise.reject(new LinkError('not-ready', 'The schema is not known yet'));
    }

    const result = this.#groups.request(schema, requests);

    if (this.#state.kind === 'configuring' || this.#state.kind === 'streaming') {
      this.#groups.configure();
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
  async write(variableId: number, value: WireValue): Promise<WriteResult> {
    const entry = this.#requireEntry(variableId);

    if (entry.type === TypeCode.BLOB) {
      throw new Error(`${entry.name} is a blob; only primitives can be written`);
    }

    validateValue(value, entry.type);
    return this.#writes.write(variableId, value, writeValue(value, entry.type));
  }

  /** The value of the newest write to a variable that the robot has not answered yet. */
  pendingWrite(variableId: number): WireValue | undefined {
    return this.#writes.pending(variableId);
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
    const entry = this.#requireEntry(variableId);
    const bytes =
      entry.type === TypeCode.BLOB
        ? await this.#sizeRefusals.run(() => {
            if (this.#requireEntry(variableId) !== entry) {
              throw this.#notReady();
            }

            return this.#requestValue(variableId, true);
          })
        : await this.#requestValue(variableId, false);
    const value = decodeReadValue(entry, bytes);

    this.#events.emit('value', { variableId, value });
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

    if (!LINK_UP_STATES.has(this.#state.kind)) {
      return Promise.reject(this.#notReady());
    }

    const answer = this.#requests.add(
      'command',
      code,
      this.#timing.requestTimeoutMs,
      (error, context) => error === ErrorCode.MALFORMED && context === code
    );

    this.#send(encodeCommand(code, argument));
    return answer;
  }

  #requestValue(variableId: number, mayBeTooLarge: boolean): Promise<Uint8Array> {
    const answer = this.#requests.add(
      'read',
      variableId,
      this.#timing.requestTimeoutMs,
      (code, context) =>
        context === variableId &&
        (code === ErrorCode.NO_SUCH_VARIABLE ||
          (mayBeTooLarge && code === ErrorCode.GROUP_TOO_LARGE))
    );

    this.#send(encodeRead(variableId));
    return answer;
  }

  #onTransportState(): void {
    if (this.#state.kind === 'closed') {
      return;
    }

    if (this.#transport.state.kind === 'open') {
      this.#reader.clear();
      this.#counters.report(this.#timing.statsIntervalMs, (stats) =>
        this.#events.emit('stats', stats)
      );
      this.#startHandshake('connected');
    } else if (this.#state.kind !== 'disconnected') {
      this.#stopActivity(new LinkError('disconnected', 'The transport closed'), 'disconnected');
      this.#counters.stopReporting();
      this.#reader.clear();
      this.#setState({ kind: 'disconnected' });
    }
  }

  #startHandshake(reason: HandshakeReason): void {
    this.#stopActivity(
      new LinkError('restarted', `The handshake restarted (${reason})`),
      'restarted',
      ['group', 'ping']
    );
    this.#handshakeReason = reason;
    this.#helloAttempt = 0;
    this.#helloBackoff.reset();
    this.#sendHello();
  }

  #sendHello(): void {
    this.#helloAttempt++;
    this.#counters.add('handshakes');
    this.#send(encodeHello());
    this.#setState({
      kind: 'handshaking',
      reason: this.#handshakeReason,
      attempt: this.#helloAttempt,
    });
    this.#armStateTimer(this.#helloBackoff.next(), () => this.#sendHello());
  }

  #onHelloAck(ack: HelloAck | ForeignHelloAck): void {
    if (this.#state.kind !== 'handshaking') {
      return;
    }

    clearTimeout(this.#stateTimer);

    if (!isSupported(ack)) {
      this.#fail(new Error(unsupportedVersion(ack.version)));
      return;
    }

    const previousBoot = this.#info?.bootId;

    const { type: _type, version, ...announced } = ack;
    this.#info = { protocolVersion: version, ...announced };

    if (previousBoot === undefined) {
      this.#epochs.beginTimeline('connected');
    } else if (previousBoot !== ack.bootId) {
      this.#epochs.beginTimeline('reboot');
    }

    this.#credit.start(ack.creditWindow);
    this.#groups.forgetRobotGroups();
    this.#watchdog.start(performance.now());
    this.#applySchemaProgress(this.#schemaLoader.begin(ack.schemaHash, ack.variableCount));
  }

  #applySchemaProgress(progress: SchemaProgress): void {
    switch (progress.kind) {
      case 'unchanged':
        this.#groups.configure();
        break;
      case 'ready':
        this.#adoptSchema(progress);
        break;
      case 'loading':
        this.#setState({
          kind: 'loadingSchema',
          received: progress.received,
          total: progress.total,
        });
        this.#armStateTimer(this.#timing.schemaTimeoutMs, () =>
          this.#startHandshake('schema-retry')
        );
        break;
    }
  }

  #adoptSchema(ready: Extract<SchemaProgress, { kind: 'ready' }>): void {
    clearTimeout(this.#stateTimer);

    if (this.#adoptedHash !== undefined && this.#adoptedHash !== ready.hash) {
      this.#groups.dropLayout(new LinkError('restarted', 'The robot has a different schema now'));
    }

    const { kind: _kind, ...schema } = ready;
    this.#adoptedHash = ready.hash;
    this.#events.emit('schema', schema);
    this.#groups.configure();
  }

  #onBytes(bytes: Uint8Array): void {
    const at = performance.now();
    const frames = this.#reader.push(bytes);

    this.#counters.add('bytesIn', bytes.length);
    this.#counters.add('framesDiscarded', this.#reader.discarded - this.#discardedSeen);
    this.#discardedSeen = this.#reader.discarded;

    if (frames.length > 0) {
      this.#watchdog.heard(at);
    }

    for (const frame of frames) {
      const message = decodeMessage(frame);
      this.#counters.add('framesIn');
      this.#credit.received(frame, at);

      if (message) {
        this.#handle(message);
      } else {
        this.#counters.add('framesUndecodable');
        this.#context.report(
          `Unreadable ${MessageType[frame.type] ?? `0x${frame.type.toString(16)}`} frame of ${frame.payload.length} bytes`
        );
      }
    }

    this.#credit.giveBack(at);
  }

  #handle(message: RobotMessage): void {
    switch (message.type) {
      case MessageType.HELLO_ACK:
        this.#onHelloAck(message);
        break;
      case MessageType.SCHEMA_PAGE:
        if (this.#state.kind === 'loadingSchema') {
          this.#applySchemaProgress(this.#schemaLoader.accept(message));
        }
        break;
      case MessageType.SAMPLE:
        this.#onSample(message);
        break;
      case MessageType.PONG:
        if (
          this.#requests.answer(message) &&
          !this.#credit.resync(message.sentTotal, performance.now())
        ) {
          this.#startHandshake('credit-resync');
        }
        break;
      case MessageType.LOG:
        this.#events.emit('log', {
          severity: message.severity,
          text: message.text,
          timeUs: this.#epochs.place(message.timestampUs),
        });
        break;
      case MessageType.ERROR:
        if (!this.#requests.answer(message)) {
          this.#context.report(
            `The robot sent ${ErrorCode[message.code] ?? message.code} (${message.context})`,
            message.code,
            message.context
          );
        }
        break;
      default:
        this.#requests.answer(message);
    }
  }

  /**
   * Take a sample into its epoch while groups stream, and have its group defined again or turned
   * off when it belongs to none.
   */
  #onSample(sample: Sample): void {
    if (this.#state.kind !== 'configuring' && this.#state.kind !== 'streaming') {
      return;
    }

    const at = performance.now();
    const outcome = this.#epochs.receive(sample, at, this.#info?.loopTimeUs ?? 0);

    if (outcome === 'accepted') {
      this.#watchdog.sampled(at);
    } else {
      this.#groups.noteUnknown(sample.group);
    }
  }

  #fail(error: Error): void {
    this.#stopActivity(error, 'restarted');
    this.#groups.rejectWaiters(error);
    this.#setState({ kind: 'error', error });
  }

  /**
   * Stop everything the current handshake started: timers, the robot's groups and credit, and
   * the requests that depend on them.
   *
   * @param error What the requests fail with.
   * @param reason Why the open epochs end.
   * @param kinds The requests to fail; every one, writes held back included, when left out.
   */
  #stopActivity(error: Error, reason: EpochEndReason, kinds?: readonly RequestKind[]): void {
    this.#generation++;
    clearTimeout(this.#stateTimer);
    this.#credit.stop();
    this.#watchdog.stop();

    if (!kinds) {
      this.#writes.failHeld(error);
    }

    this.#requests.rejectAll(error, kinds);
    this.#epochs.endAll(reason);
  }

  #armStateTimer(delayMs: number, action: () => void): void {
    clearTimeout(this.#stateTimer);
    this.#stateTimer = setTimeout(action, delayMs);
  }

  #requireEntry(variableId: number): SchemaEntry {
    const schema = this.schema;

    if (!LINK_UP_STATES.has(this.#state.kind) || !schema) {
      throw this.#notReady();
    }

    const entry = schema[variableId] as SchemaEntry | undefined;

    if (!entry) {
      throw new Error(`No variable ${variableId} in the schema`);
    }

    return entry;
  }

  #notReady(): LinkError {
    return new LinkError('not-ready', `The link is ${this.#state.kind}`);
  }

  #send(frame: Uint8Array): void {
    if (this.#transport.state.kind !== 'open') {
      return;
    }

    this.#transport.send(frame);
    this.#counters.add('bytesOut', frame.length);
  }

  #setState(state: LinkState): void {
    this.#state = state;
    this.#events.emit('state', state);
  }
}
