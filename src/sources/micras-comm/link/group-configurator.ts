import {
  ErrorCode,
  MAX_GROUP_VARIABLES,
  MAX_GROUPS,
  MAX_PAYLOAD_SIZE,
  TYPE_SIZE,
  TypeCode,
} from '../wire';
import type { Epoch, EpochRegistry } from './epochs';
import { asError, RobotError, LinkError, TimeoutError } from './errors';
import type { GroupsResult, LinkContext } from './link-events';
import {
  encodeGroupDefine,
  encodeGroupEnable,
  encodePing,
  SAMPLE_HEADER_SIZE,
  type GroupAck,
} from './messages';
import type { AsyncMutex, ErrorMatcher } from './requests';
import type { SchemaEntry } from './schema';

/** A set of variables to stream together, sampled in the same loop iteration. */
export interface GroupRequest {
  /** The variables, in the order their values are packed. */
  readonly variableIds: readonly number[];

  /** How many loop iterations between two samples. */
  readonly periodTicks: number;
}

/** A group request checked against the schema, ready to be sent. */
export interface GroupLayout extends GroupRequest {
  /** The slot on the robot, which is the position of the request. */
  readonly group: number;

  /** The type of each variable. */
  readonly types: readonly TypeCode[];

  /** The bytes of the values of one sample. */
  readonly sampleSize: number;
}

/**
 * Check a set of group requests against the schema and the robot's limits.
 *
 * @param schema The robot's schema.
 * @param requests One request per group, at most `MAX_GROUPS`.
 * @returns The layouts to send.
 * @throws If a request cannot be streamed as asked.
 */
export function toGroupLayouts(
  schema: readonly SchemaEntry[],
  requests: readonly GroupRequest[]
): GroupLayout[] {
  if (requests.length > MAX_GROUPS) {
    throw new Error(`The robot holds ${MAX_GROUPS} groups, ${requests.length} were asked for`);
  }

  return requests.map((request, group) => planGroup(schema, request, group));
}

function planGroup(
  schema: readonly SchemaEntry[],
  request: GroupRequest,
  group: number
): GroupLayout {
  const { variableIds, periodTicks } = request;

  if (variableIds.length === 0 || variableIds.length > MAX_GROUP_VARIABLES) {
    throw new Error(`Group ${group} must have 1 to ${MAX_GROUP_VARIABLES} variables`);
  }

  if (!Number.isInteger(periodTicks) || periodTicks < 1 || periodTicks > 0xffff) {
    throw new Error(`Group ${group} period must be 1 to 65535 ticks, got ${periodTicks}`);
  }

  const types = variableIds.map((id) => streamableType(schema, id));
  const sampleSize = types.reduce((total, type) => total + TYPE_SIZE[type], 0);

  if (sampleSize + SAMPLE_HEADER_SIZE > MAX_PAYLOAD_SIZE) {
    throw new Error(`Group ${group} samples would take ${sampleSize} bytes, too many for a frame`);
  }

  return { group, variableIds: [...variableIds], periodTicks, types, sampleSize };
}

function streamableType(schema: readonly SchemaEntry[], id: number): TypeCode {
  const entry = schema[id] as SchemaEntry | undefined;

  if (!entry) {
    throw new Error(`No variable ${id} in the schema`);
  }

  if (!entry.access.stream || entry.type === TypeCode.BLOB) {
    throw new Error(`${entry.name} cannot be streamed`);
  }

  return entry.type;
}

interface Waiter {
  layouts: readonly GroupLayout[];
  resolve(result: GroupsResult): void;
  reject(error: Error): void;
}

/**
 * Brings the robot's groups in line with the layout asked for, one GROUP_DEFINE and GROUP_ENABLE
 * at a time, and keeps that layout to apply again after every handshake.
 *
 * A group whose definition or enabling failed may or may not be streaming on the robot, so it is
 * treated as unknown and turned off, and so is any group samples arrive for without an epoch. A
 * definition waits for a blob READ the robot has not answered, so that a GROUP_TOO_LARGE is never
 * taken for the answer to the other.
 *
 * A GROUP_ACK names only the group, and the answers to a define and an enable of the same group
 * read the same. So once a request was sent again after a timeout, the answer to the attempt that
 * timed out may still be on its way: the configurator waits for a PONG before the next request,
 * since the robot answers in order and the late answer arrives first.
 */
export class GroupConfigurator {
  readonly #context: LinkContext;
  readonly #epochs: EpochRegistry;
  readonly #sizeRefusals: AsyncMutex;
  readonly #configuring: (busy: boolean) => void;
  readonly #unknown = new Set<number>();
  #desired: readonly GroupLayout[] = [];
  #waiters: Waiter[] = [];
  #runningGeneration: number | null = null;
  #pending = false;

  /**
   * @param context What the configurator shares with its link.
   * @param epochs Where the epochs of the groups begin and end.
   * @param sizeRefusals Where a GROUP_DEFINE takes turns with a blob READ: the robot refuses either
   *   with GROUP_TOO_LARGE and a context that may be the same number, so only one of them may wait
   *   for its answer at a time.
   * @param configuring Told true as a pass starts changing the robot's groups, and false once every
   *   pass is done and nothing more is waiting to be applied.
   */
  constructor(
    context: LinkContext,
    epochs: EpochRegistry,
    sizeRefusals: AsyncMutex,
    configuring: (busy: boolean) => void
  ) {
    this.#context = context;
    this.#epochs = epochs;
    this.#sizeRefusals = sizeRefusals;
    this.#configuring = configuring;
  }

  /**
   * Ask for a new layout, replacing the one asked for before.
   *
   * @param schema The robot's schema, which the requests are checked against.
   * @param requests One request per group.
   * @returns How the layout ended.
   */
  request(
    schema: readonly SchemaEntry[],
    requests: readonly GroupRequest[]
  ): Promise<GroupsResult> {
    let layouts: GroupLayout[];

    try {
      layouts = toGroupLayouts(schema, requests);
    } catch (error) {
      return Promise.reject(asError(error));
    }

    this.#supersedeWaiters();
    this.#desired = layouts;

    return new Promise<GroupsResult>((resolve, reject) => {
      this.#waiters.push({ layouts, resolve, reject });
    });
  }

  /** Apply the layout asked for, now or as soon as the pass running finishes. */
  configure(): void {
    this.#pending = true;

    if (this.#runningGeneration !== this.#context.generation()) {
      void this.#run(this.#context.generation());
    }
  }

  /** The robot forgot its groups, as it does on HELLO. */
  forgetRobotGroups(): void {
    this.#unknown.clear();
  }

  /**
   * Samples arrived for a group that belong to no epoch of it, so what the robot streams in it is
   * not known: define it again, or turn it off when the layout has nothing for it. Samples the
   * robot sent before it saw a GROUP_ENABLE arrive before its GROUP_ACK, so once that ACK is in,
   * no more arrive.
   */
  noteUnknown(group: number): void {
    this.#unknown.add(group);
    this.configure();
  }

  /** Drop the layout, because the schema it names variables of changed. */
  dropLayout(error: Error): void {
    this.#desired = [];
    this.rejectWaiters(error);
  }

  /** Fail every layout still waiting. */
  rejectWaiters(error: Error): void {
    const waiters = this.#waiters;
    this.#waiters = [];
    waiters.forEach((waiter) => waiter.reject(error));
  }

  async #run(generation: number): Promise<void> {
    this.#runningGeneration = generation;

    try {
      while (this.#pending && generation === this.#context.generation()) {
        this.#pending = false;
        await this.#applyDesired(generation);
      }
    } finally {
      if (this.#runningGeneration === generation) {
        this.#runningGeneration = null;
      }
    }
  }

  async #applyDesired(generation: number): Promise<void> {
    const layouts = this.#desired;
    const groups = allGroups().filter((group) => this.#needsChange(group, layouts));
    const failures: Error[] = [];

    if (groups.length > 0) {
      this.#configuring(true);
    }

    for (const group of groups) {
      const failure = await this.#applyGroup(group, layoutOf(layouts, group), generation);

      if (generation !== this.#context.generation()) {
        return;
      }

      if (failure) {
        failures.push(failure);
      }
    }

    if (failures.length > 0 && this.#desired === layouts) {
      this.#desired = layouts.filter((layout) => this.#epochs.isActive(layout.group));
    }

    if (!this.#pending) {
      this.#configuring(false);
    }

    this.#settleWaiters(layouts, failures);
  }

  #needsChange(group: number, layouts: readonly GroupLayout[]): boolean {
    const layout = layoutOf(layouts, group);
    const current = this.#epochs.current(group);

    if (!layout) {
      return (current?.active ?? false) || this.#unknown.has(group);
    }

    return !(current?.active && sameLayout(layout, current.epoch));
  }

  async #applyGroup(
    group: number,
    layout: GroupLayout | undefined,
    generation: number
  ): Promise<Error | undefined> {
    try {
      if (layout) {
        await this.#defineAndEnable(layout, generation);
      } else {
        await this.#turnOff(group, generation);
      }

      return undefined;
    } catch (error) {
      if (generation === this.#context.generation()) {
        await this.#giveUpOn(group, generation);
      }

      return asError(error);
    }
  }

  async #defineAndEnable(layout: GroupLayout, generation: number): Promise<void> {
    const { group } = layout;

    this.#unknown.add(group);

    const ack = await this.#sizeRefusals.run(() => {
      this.#throwIfRestarted(generation);
      return this.#groupRequest(
        encodeGroupDefine(group, layout.periodTicks, layout.variableIds),
        group,
        answersDefine(layout)
      );
    });
    this.#throwIfRestarted(generation);

    if (ack.sampleSize !== layout.sampleSize) {
      throw new Error(
        `The robot acknowledged ${ack.sampleSize} bytes for group ${group}; the schema adds up to ${layout.sampleSize}`
      );
    }

    this.#epochs.define(layout, ack);

    await this.#groupRequest(encodeGroupEnable(group, true), group, noSuchGroup(group));
    this.#throwIfRestarted(generation);

    this.#epochs.activate(group);
    this.#unknown.delete(group);
  }

  async #turnOff(group: number, generation: number): Promise<void> {
    try {
      await this.#groupRequest(encodeGroupEnable(group, false), group, noSuchGroup(group));
    } catch (error) {
      if (!isNoSuchGroup(error)) {
        throw error;
      }
    }

    this.#throwIfRestarted(generation);
    this.#epochs.end(group, 'disabled');
    this.#unknown.delete(group);
  }

  async #giveUpOn(group: number, generation: number): Promise<void> {
    this.#epochs.end(group, 'failed');
    this.#unknown.add(group);

    try {
      await this.#turnOff(group, generation);
    } catch (error) {
      if (generation === this.#context.generation()) {
        this.#context.report(`Group ${group} could not be turned off: ${asError(error).message}`);
      }
    }
  }

  async #groupRequest(
    frame: Uint8Array,
    group: number,
    answersError: ErrorMatcher
  ): Promise<GroupAck> {
    const { requests, timing } = this.#context;

    for (let attempt = 1; ; attempt++) {
      const answer = requests.add('group', group, timing.requestTimeoutMs, answersError);
      this.#context.send(frame);

      try {
        const ack = await answer;

        if (attempt > 1) {
          await this.#letLateAnswersPass();
        }

        return ack;
      } catch (error) {
        if (!(error instanceof TimeoutError)) {
          throw error;
        }

        if (attempt >= timing.groupAttempts) {
          await this.#letLateAnswersPass();
          throw error;
        }
      }
    }
  }

  /**
   * Wait for a PONG: the robot answers in order, so whatever it still had to answer of the
   * attempts that timed out has arrived by then, with no group request waiting to take it.
   */
  async #letLateAnswersPass(): Promise<void> {
    const pong = this.#context.requests.add('ping', 0, this.#context.timing.requestTimeoutMs);

    this.#context.send(encodePing());
    await pong.catch(() => undefined);
  }

  #throwIfRestarted(generation: number): void {
    if (generation !== this.#context.generation()) {
      throw new LinkError('restarted');
    }
  }

  #supersedeWaiters(): void {
    const waiters = this.#waiters;
    this.#waiters = [];
    waiters.forEach((waiter) => waiter.resolve({ status: 'superseded' }));
  }

  #settleWaiters(layouts: readonly GroupLayout[], failures: readonly Error[]): void {
    const settled = this.#waiters.filter((waiter) => waiter.layouts === layouts);
    this.#waiters = this.#waiters.filter((waiter) => waiter.layouts !== layouts);

    for (const waiter of settled) {
      if (failures.length > 0) {
        waiter.reject(failures[0]);
      } else {
        waiter.resolve({ status: 'applied', epochs: this.#epochs.active() });
      }
    }
  }
}

function sameLayout(layout: GroupLayout, epoch: Epoch): boolean {
  return (
    layout.group === epoch.group &&
    layout.periodTicks === epoch.periodTicks &&
    layout.variableIds.length === epoch.variableIds.length &&
    layout.variableIds.every((id, index) => epoch.variableIds[index] === id)
  );
}

function allGroups(): number[] {
  return Array.from({ length: MAX_GROUPS }, (_, group) => group);
}

function layoutOf(layouts: readonly GroupLayout[], group: number): GroupLayout | undefined {
  return layouts.find((layout) => layout.group === group);
}

function isNoSuchGroup(error: unknown): boolean {
  return error instanceof RobotError && error.code === ErrorCode.NO_SUCH_GROUP;
}

function noSuchGroup(group: number): ErrorMatcher {
  return (code, context) => code === ErrorCode.NO_SUCH_GROUP && context === group;
}

function answersDefine(layout: GroupLayout): ErrorMatcher {
  return (code, context) => {
    switch (code) {
      case ErrorCode.NO_SUCH_GROUP:
        return context === layout.group;
      case ErrorCode.GROUP_TOO_LARGE:
        return context === layout.variableIds.length || context === layout.sampleSize;
      case ErrorCode.NOT_STREAMABLE:
      case ErrorCode.NO_SUCH_VARIABLE:
        return layout.variableIds.includes(context);
      default:
        return false;
    }
  };
}
