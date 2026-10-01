/**
 * One connection of the micras-comm source: a link and its planner, driven by the monitor and
 * reported to its sink.
 *
 * @module
 */

import type { Unsubscribe } from '@/core/emitter';
import type { LogSeverity } from '@/core/log';
import {
  NOT_CONNECTED,
  type CommandOutcome,
  type ReadOutcome,
  type SourceConnection,
  type SourceSink,
  type SourceStatus,
  type StreamDemand,
  type Target,
  type WriteOutcome,
  type WriteRefusal,
  type WriteValue,
} from '@/core/source';
import type { Variable } from '@/core/variables';

import { connectionStats, connectionStatus, phaseOf, type LinkPhase } from './connection-status';
import { asError } from './link/errors';
import type { LinkState } from './link/link-events';
import type { RobotLink } from './link/robot-link';
import type { SchemaEntry } from './link/schema';
import { StreamFeed } from './stream-feed';
import type { RateRequest } from './streaming/fit-groups';
import type { StreamPlanner } from './streaming/stream-planner';
import { BluetoothTransport } from './transports/bluetooth/bluetooth-transport';
import type { Transport, TransportState } from './transports/transport';
import { variableOf } from './value-types';
import { CommandResult, Severity, WriteStatus } from './wire';

/** A robot link with the transport under it and the planner over it. */
export interface Link {
  readonly transport: Transport;
  readonly link: RobotLink;
  readonly planner: StreamPlanner;
}

/** A link whose Bluetooth transport stopped until the user clicks. */
export type ParkedLink = Link & { readonly transport: BluetoothTransport };

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

/** Whether a link waits for a click to reach its Bluetooth device again. */
export function waitsForGesture(link: Link): link is ParkedLink {
  const { transport } = link;
  return (
    transport instanceof BluetoothTransport &&
    transport.state.kind === 'closed' &&
    transport.state.reason === 'needs-user-gesture'
  );
}

/** Stop the planner and close the link, and with it the transport. */
export function closeLink({ link, planner }: Link): void {
  planner.close();
  link.close();
}

/**
 * The protocol work between a link and the monitor's sink: the link's state as the status, its
 * schema as the variables, its streams through a {@link StreamFeed}, and the monitor's demands,
 * commands, writes and reads as the link's.
 *
 * The status is told only when it changes: when the link moves to another phase, or, while it is
 * down, when its transport does.
 */
export class MicrasCommConnection implements SourceConnection {
  readonly #target: Target;
  readonly #sink: SourceSink;
  readonly #park: (link: ParkedLink) => void;
  readonly #feed: StreamFeed;
  #link: Link | null = null;
  #detach: readonly Unsubscribe[] = [];
  #closed = false;
  #status: SourceStatus | null = null;
  #phase: LinkPhase | null = null;
  #transportState: TransportState | null = null;
  #since = 0;
  #schema: readonly SchemaEntry[] | undefined;
  #variables: readonly Variable[] = [];
  #robotName: string | null = null;
  #demands: readonly StreamDemand[] = [];
  #droppedSinceStats = 0;

  /**
   * @param target Where the connection goes.
   * @param sink Where it reports.
   * @param park Keeps a link that waits for a click once the connection closes, so that the next
   *   connection reaches the same device.
   */
  constructor(target: Target, sink: SourceSink, park: (link: ParkedLink) => void) {
    this.#target = target;
    this.#sink = sink;
    this.#park = park;
    this.#feed = new StreamFeed(sink);
  }

  /**
   * Runs over a link: listens to it and opens it, or reaches its Bluetooth device again if it
   * waits for a click, unless the connection was closed meanwhile.
   */
  start(link: Link): void {
    if (this.#closed) {
      closeLink(link);
      return;
    }

    const { transport, link: robotLink, planner } = link;
    this.#link = link;
    this.#detach = [
      transport.onState((state) => this.#onTransportState(state)),
      transport.onError((error) => this.#note('warning', error.message)),
      robotLink.on('state', (state) => this.#onLinkState(state)),
      robotLink.on('schema', () => this.#refreshVariables()),
      robotLink.on('dropped', ({ count }) => {
        this.#droppedSinceStats += count;
      }),
      robotLink.on('value', ({ variableId, value }) => this.#sink.value(variableId, value)),
      robotLink.on('write', () => this.#sink.writesChanged()),
      robotLink.on('log', ({ severity, text, timeUs }) =>
        this.#sink.log({
          severity: SEVERITIES[severity] ?? 'info',
          source: 'robot',
          text,
          at: { clock: this.#feed.clock, timeUs },
        })
      ),
      robotLink.on('protocolError', ({ message }) => this.#note('warning', message)),
      robotLink.on('stats', () => this.#onStats()),
      ...this.#feed.listen(robotLink),
      planner.on('plan', () => this.#refreshStats()),
      planner.on('error', (error) => this.#note('warning', `stream plan: ${error.message}`)),
    ];
    this.request(this.#demands);

    if (waitsForGesture(link)) {
      link.transport.reconnect();
    } else {
      robotLink.open();
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
    this.#feed.watchCredit(demands.find((demand) => demand.role === 'link.credit')?.variableId);
    this.#link?.planner.request(this.#rateRequests());
  }

  async command(code: number, argument = 0): Promise<CommandOutcome> {
    const link = this.#linked();

    if (link === undefined) {
      return { status: 'failed', message: NOT_CONNECTED };
    }

    try {
      const reply = await link.command(code, argument);
      return { status: COMMAND_STATUS[reply.result], reason: reply.reason ?? null };
    } catch (error) {
      return { status: 'failed', message: asError(error).message };
    }
  }

  async write(variableId: number, value: WriteValue): Promise<WriteOutcome> {
    const link = this.#linked();

    if (link === undefined) {
      return { status: 'failed', message: NOT_CONNECTED };
    }

    try {
      const result = await link.write(variableId, value);

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
    const link = this.#linked();

    if (link === undefined) {
      return { status: 'failed', message: NOT_CONNECTED };
    }

    try {
      return { status: 'ok', value: await link.read(variableId) };
    } catch (error) {
      return { status: 'failed', message: asError(error).message };
    }
  }

  pendingWrite(variableId: number): WriteValue | undefined {
    return this.#link?.link.pendingWrite(variableId);
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

  #linked(): RobotLink | undefined {
    return this.#status?.kind === 'linked' ? this.#link?.link : undefined;
  }

  #onTransportState(state: TransportState): void {
    if (state.kind === 'closed' && state.reason === 'taken-over' && state.error !== undefined) {
      this.#note('warning', state.error.message);
    }

    this.#refreshStatus();
  }

  #onLinkState(state: LinkState): void {
    const text = describeState(state);

    if (text !== null) {
      this.#note(state.kind === 'error' ? 'error' : 'info', text);
    }

    this.#refreshVariables();
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

  /**
   * Tells the monitor the robot's variables when the link learns a schema. While the same robot
   * loads a different one, as after a new build, the variables known stay, so the robot package
   * on screen does not flicker; the link refuses requests until the new schema is in, and
   * another robot, by name, drops them at once.
   */
  #refreshVariables(): void {
    const link = this.#link?.link;
    const schema = link?.schema;

    if (schema === this.#schema) {
      return;
    }

    if (schema !== undefined) {
      this.#schema = schema;
      this.#robotName = link?.robot?.robotName ?? null;
      this.#setVariables(schema.map(variableOf));
      return;
    }

    if ((link?.robot?.robotName ?? null) !== this.#robotName) {
      this.#schema = undefined;
      this.#setVariables([]);
    }
  }

  #setVariables(variables: readonly Variable[]): void {
    this.#variables = variables;
    this.#sink.variables(variables);
  }

  #onStats(): void {
    if (this.#droppedSinceStats > 0) {
      this.#note('warning', `${this.#droppedSinceStats} samples dropped`);
      this.#droppedSinceStats = 0;
    }

    this.#refreshStats();
  }

  #refreshStats(): void {
    if (this.#link === null) {
      return;
    }

    const { link, planner } = this.#link;
    this.#sink.stats(
      connectionStats({
        counters: link.stats,
        budget: planner.budget,
        plan: planner.plan,
        creditWindow: link.robot?.creditWindow ?? 0,
        creditLeft: this.#feed.creditLeft,
        variables: this.#variables,
      })
    );
  }

  /**
   * Tells the status when it changed: the link moved to another phase, or it is down and its
   * transport moved.
   */
  #refreshStatus(): void {
    if (this.#link === null || this.#closed) {
      return;
    }

    const { link, transport } = this.#link;
    const phase = phaseOf(link.state);
    const transportState = phase === 'down' ? transport.state : null;

    if (phase === this.#phase && transportState === this.#transportState) {
      return;
    }

    if (phase !== this.#phase) {
      this.#since = phase === 'up' ? Date.now() : 0;
    }

    this.#phase = phase;
    this.#transportState = transportState;
    this.#setStatus(
      connectionStatus({
        target: this.#target,
        transport: transport.state,
        link: link.state,
        robot: link.robot,
        since: this.#since,
      })
    );
  }

  /** Reports a new status; one that ends the link also tells the sink the variables are gone. */
  #setStatus(status: SourceStatus): void {
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
