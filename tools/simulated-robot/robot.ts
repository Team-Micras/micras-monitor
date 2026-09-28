/**
 * A robot that speaks the protocol, so that the whole application can be developed and debugged
 * before a radio module is plugged into anything.
 *
 * It implements the same session as `micras_comm` at protocol version 2: the handshake with its
 * boot id, a paged schema, coherent groups at whatever period is asked for, the cumulative credit
 * window, logs held for credit, writes with their acknowledgements, and commands refused or
 * accepted by the state the robot is in. It acts on at most one message per loop iteration and
 * checks every request in the order the firmware does. The signals are made up; everything around
 * them is not.
 *
 * @module
 */

import {
  CommandResult,
  CREDIT_WINDOW,
  encodeFrame,
  ErrorCode,
  FrameReader,
  MAX_GROUPS,
  MAX_GROUP_VARIABLES,
  MAX_PAYLOAD_SIZE,
  MessageType,
  PROTOCOL_VERSION,
  Severity,
  TYPE_SIZE,
  TypeCode,
  Writer,
  WriteStatus,
  writeValue,
  type Frame,
} from '../../src/protocol';
import { Command, Reason, refusal, RobotState, toCommand } from './commands';
import { seededRandom, type FaultOptions, type RobotStats } from './faults';
import {
  ACCESS_IDLE,
  ACCESS_STREAM,
  ACCESS_WRITE,
  createVariables,
  schemaHash,
  type Variable,
} from './variables';
import type { Wire } from './wire';

/** The period of the firmware's control loop. */
export const LOOP_TIME_US = 125;

/** The name the robot introduces itself with. */
export const ROBOT_NAME = 'micras';

const SAMPLE_HEADER_SIZE = 7;
const LOG_HEADER_SIZE = 5;
const U32_RANGE = 2 ** 32;

/** How long, in seconds of robot time, each busy state lasts before the robot is idle again. */
const BUSY_SECONDS: Readonly<Partial<Record<RobotState, number>>> = {
  [RobotState.RUN]: 5,
  [RobotState.CALIBRATE]: 1,
  [RobotState.SAVE]: 0.2,
};

const STATE_CODES: Readonly<Record<RobotState, number>> = {
  [RobotState.IDLE]: 1,
  [RobotState.RUN]: 3,
  [RobotState.SAVE]: 5,
  [RobotState.CALIBRATE]: 7,
  [RobotState.ERROR]: 12,
};

interface Group {
  ids: number[];
  period: number;
  sampleSize: number;
  enabled: boolean;
  counter: number;
  sequence: number;
}

/**
 * Reads a payload the way the firmware's `Reader` does: a read past the end gives zero and marks
 * the reader invalid instead of throwing, so each request decides what a short payload means.
 */
class LenientReader {
  private index = 0;
  private overrun = false;

  constructor(private readonly payload: Uint8Array) {}

  get valid(): boolean {
    return !this.overrun;
  }

  u8(): number {
    return this.take(1);
  }

  u16(): number {
    return this.take(2);
  }

  u32(): number {
    return this.take(4);
  }

  rest(): Uint8Array {
    return this.payload.subarray(Math.min(this.index, this.payload.length));
  }

  private take(size: number): number {
    if (this.index + size > this.payload.length) {
      this.overrun = true;
      this.index = this.payload.length;
      return 0;
    }

    let value = 0;

    for (let byte = size - 1; byte >= 0; byte--) {
      value = value * 256 + this.payload[this.index + byte];
    }

    this.index += size;
    return value;
  }
}

/**
 * The bytes the robot sent on its own initiative against what the monitor said it consumed, as
 * `CreditWindow` in the firmware: two u32 totals since HELLO, wrapping.
 */
class CreditWindow {
  private sent = 0;
  private consumed = 0;

  reset(): void {
    this.sent = 0;
    this.consumed = 0;
  }

  allows(size: number): boolean {
    return this.outstanding + size <= CREDIT_WINDOW;
  }

  charge(size: number): void {
    this.sent = (this.sent + size) % U32_RANGE;
  }

  acknowledge(consumedTotal: number): number {
    const acknowledged = (consumedTotal - this.consumed + U32_RANGE) % U32_RANGE;

    if (acknowledged > this.outstanding) {
      return 0;
    }

    this.consumed = consumedTotal;
    return acknowledged;
  }

  get sentTotal(): number {
    return this.sent;
  }

  get available(): number {
    return CREDIT_WINDOW - Math.min(this.outstanding, CREDIT_WINDOW);
  }

  private get outstanding(): number {
    return (this.sent - this.consumed + U32_RANGE) % U32_RANGE;
  }
}

/** One simulated robot, on one connection. */
export class Robot {
  private readonly reader = new FrameReader();
  private readonly inbox: Frame[] = [];
  private readonly window = new CreditWindow();
  private readonly bootRandom: () => number;
  private variables: Variable[] = createVariables();
  private groups: (Group | undefined)[] = [];
  private schemaIndex = 0;
  private schemaPagesSent = 0;
  private iteration = 0;
  private state = RobotState.IDLE;
  private busyUntil = 0;
  private bootId: number | null = null;
  private heldLog: Uint8Array | null = null;
  private creditsToDrop: number;

  /**
   * @param wire The radio it talks through.
   * @param faults The faults to inject.
   * @param stats Where to count what it did.
   * @param log Where to report writes and commands.
   */
  constructor(
    private readonly wire: Wire,
    private readonly faults: FaultOptions,
    private readonly stats: RobotStats,
    private readonly log: (message: string) => void
  ) {
    this.creditsToDrop = faults.dropCredits;
    this.bootRandom = seededRandom(faults.seed ^ 0x5bd1e995);
    this.boot();
  }

  /** How many variables it registers. */
  get variableCount(): number {
    return this.variables.length;
  }

  /** The hash of its schema. */
  get schemaHash(): number {
    return schemaHash(this.variables);
  }

  /** The state the robot is in. */
  get robotState(): RobotState {
    return this.state;
  }

  /** Start over as if power cycled, keeping the radio connected. */
  reboot(): void {
    this.stats.reboots++;
    this.log('rebooting');
    this.boot();
  }

  /** Go into the error state, as a fault found while running does. */
  fault(): void {
    this.enter(RobotState.ERROR);
  }

  /**
   * One control loop iteration: act on at most one message, then send whatever is due, as
   * `poll` and `pump` do in the firmware.
   */
  tick(): void {
    this.iteration++;

    const frame = this.inbox.shift();

    if (frame) {
      this.execute(frame);
    }

    this.advanceState();
    this.pump();
  }

  /** Take bytes from the radio. */
  receive(data: Uint8Array): void {
    this.inbox.push(...this.reader.push(data));
  }

  private boot(): void {
    this.variables = createVariables();
    this.groups = Array.from({ length: MAX_GROUPS }, () => undefined);
    this.window.reset();
    this.inbox.length = 0;
    this.reader.clear();
    this.schemaIndex = this.variables.length;
    this.iteration = 0;
    this.state = RobotState.IDLE;
    this.bootId = null;
    this.heldLog = null;
    this.publishState();
    this.refreshCredit();
  }

  private timestampUs(): number {
    return (this.iteration * LOOP_TIME_US) % U32_RANGE;
  }

  private now(): number {
    return (this.iteration * LOOP_TIME_US) / 1e6;
  }

  private pump(): void {
    this.sendHeldLog();

    for (let index = 0; index < MAX_GROUPS; index++) {
      this.pumpGroup(index);
    }

    this.sendSchemaPage();
  }

  private pumpGroup(index: number): void {
    const group = this.groups[index];

    if (!group?.enabled) {
      return;
    }

    if (group.counter > 0) {
      group.counter--;
      return;
    }

    group.counter = group.period - 1;

    const payload = new Writer()
      .u8(index)
      .u16(group.sequence)
      .u32(this.timestampUs())
      .raw(this.sampleGroup(group))
      .done();

    group.sequence = (group.sequence + 1) & 0xffff;

    if (this.sendMetered(MessageType.SAMPLE, payload)) {
      this.stats.samplesSent++;
    } else {
      this.stats.samplesDropped++;
      this.variable('link/dropped_samples').value = this.stats.samplesDropped;
    }
  }

  /** The schema is paged, because a kilobyte is half a second of a link this slow. */
  private sendSchemaPage(): void {
    if (this.schemaIndex >= this.variables.length) {
      return;
    }

    const header = new Writer()
      .u32(this.schemaHash)
      .u16(this.schemaIndex)
      .u16(this.variables.length)
      .u8(0)
      .done();
    const entries: number[] = [];
    let index = this.schemaIndex;

    while (index < this.variables.length && index - this.schemaIndex < 0xff) {
      const entry = schemaEntry(this.variables[index]);

      if (header.length + entries.length + entry.length > MAX_PAYLOAD_SIZE) {
        break;
      }

      entries.push(...entry);
      index++;
    }

    const count = index - this.schemaIndex;

    if (count === 0) {
      this.schemaIndex = this.variables.length;
      return;
    }

    const payload = new Uint8Array(header.length + entries.length);
    payload.set(header, 0);
    payload.set(entries, header.length);
    payload[8] = count;

    if (this.sendMetered(MessageType.SCHEMA_PAGE, payload)) {
      this.schemaIndex = index;
    }
  }

  private variable(name: string): Variable {
    const variable = this.variables.find((candidate) => candidate.name === name);

    if (!variable) {
      throw new Error(`The simulated robot has no variable ${name}`);
    }

    return variable;
  }

  private valueOf(variable: Variable): number | boolean {
    return variable.sample ? variable.sample(this.now()) : variable.value;
  }

  private sampleGroup(group: Group): Uint8Array {
    const bytes: number[] = [];

    for (const id of group.ids) {
      const variable = this.variables[id];
      bytes.push(...writeValue(this.valueOf(variable), variable.type));
    }

    return new Uint8Array(bytes);
  }

  private execute(frame: Frame): void {
    const reader = new LenientReader(frame.payload);

    switch (frame.type) {
      case MessageType.HELLO:
        this.onHello();
        break;
      case MessageType.SCHEMA_REQUEST:
        this.onSchemaRequest(reader);
        break;
      case MessageType.GROUP_DEFINE:
        this.onGroupDefine(reader);
        break;
      case MessageType.GROUP_ENABLE:
        this.onGroupEnable(reader);
        break;
      case MessageType.CREDIT:
        this.onCredit(reader);
        break;
      case MessageType.WRITE:
        this.onWrite(reader);
        break;
      case MessageType.READ:
        this.onRead(reader);
        break;
      case MessageType.COMMAND:
        this.onCommand(reader);
        break;
      case MessageType.PING:
        this.send(MessageType.PONG, new Writer().u32(this.window.sentTotal).done());
        break;
      default:
        this.sendError(ErrorCode.UNKNOWN_TYPE, frame.type);
        break;
    }
  }

  private onHello(): void {
    this.stats.hellos++;
    this.groups.fill(undefined);
    this.schemaIndex = this.variables.length;
    this.window.reset();
    this.refreshCredit();
    this.bootId ??= Math.floor(this.bootRandom() * U32_RANGE);

    const name = new TextEncoder().encode(ROBOT_NAME);

    this.send(
      MessageType.HELLO_ACK,
      new Writer()
        .u8(PROTOCOL_VERSION)
        .u32(this.schemaHash)
        .u16(this.variables.length)
        .u32(LOOP_TIME_US)
        .u16(CREDIT_WINDOW)
        .u32(this.bootId)
        .u8(name.length)
        .raw(name)
        .done()
    );
  }

  private onSchemaRequest(reader: LenientReader): void {
    const first = reader.u16();

    if (!reader.valid || first > this.variables.length) {
      this.sendError(ErrorCode.MALFORMED, first);
      return;
    }

    this.schemaIndex = first;
  }

  private onGroupDefine(reader: LenientReader): void {
    const index = reader.u8();
    const period = Math.max(1, reader.u16());
    const count = reader.u8();

    if (!reader.valid || index >= MAX_GROUPS) {
      this.sendError(ErrorCode.NO_SUCH_GROUP, index);
      return;
    }

    if (count > MAX_GROUP_VARIABLES) {
      this.sendError(ErrorCode.GROUP_TOO_LARGE, count);
      return;
    }

    const ids: number[] = [];
    let sampleSize = 0;

    for (let position = 0; position < count; position++) {
      const id = reader.u16();
      const variable = this.variables.at(id);

      if (!variable) {
        this.sendError(ErrorCode.NO_SUCH_VARIABLE, id);
        return;
      }

      if ((variable.access & ACCESS_STREAM) === 0) {
        this.sendError(ErrorCode.NOT_STREAMABLE, id);
        return;
      }

      ids.push(id);
      sampleSize += TYPE_SIZE[variable.type];
    }

    if (!reader.valid || sampleSize + SAMPLE_HEADER_SIZE > MAX_PAYLOAD_SIZE) {
      this.sendError(ErrorCode.GROUP_TOO_LARGE, sampleSize);
      return;
    }

    this.groups[index] = { ids, period, sampleSize, enabled: false, counter: 0, sequence: 0 };
    this.sendGroupAck(index, period, sampleSize);
  }

  private onGroupEnable(reader: LenientReader): void {
    const index = reader.u8();
    const enable = reader.u8() !== 0;
    const group = this.groups.at(index);

    if (!reader.valid || index >= MAX_GROUPS || !group || group.ids.length === 0) {
      this.sendError(ErrorCode.NO_SUCH_GROUP, index);
      return;
    }

    group.enabled = enable;
    group.counter = 0;
    this.sendGroupAck(index, group.period, group.sampleSize);
  }

  private sendGroupAck(index: number, period: number, sampleSize: number): void {
    this.send(MessageType.GROUP_ACK, new Writer().u8(index).u16(period).u16(sampleSize).done());
  }

  private onCredit(reader: LenientReader): void {
    const consumedTotal = reader.u32();

    if (!reader.valid) {
      return;
    }

    if (this.creditsToDrop > 0 && this.stats.samplesSent > 0) {
      this.creditsToDrop--;
      this.stats.creditFramesDropped++;
      return;
    }

    this.stats.creditReceived += this.window.acknowledge(consumedTotal);
    this.refreshCredit();
  }

  private onWrite(reader: LenientReader): void {
    const id = reader.u16();

    if (!reader.valid) {
      this.sendError(ErrorCode.MALFORMED, id);
      return;
    }

    const status = this.write(id, reader.rest());

    this.send(MessageType.WRITE_ACK, new Writer().u16(id).u8(status).done());
  }

  private write(id: number, bytes: Uint8Array): WriteStatus {
    const variable = this.variables.at(id);

    if (!variable) {
      return WriteStatus.NO_SUCH_ID;
    }

    if ((variable.access & ACCESS_WRITE) === 0) {
      return WriteStatus.READ_ONLY;
    }

    if ((variable.access & ACCESS_IDLE) !== 0 && this.state !== RobotState.IDLE) {
      return WriteStatus.NEEDS_IDLE;
    }

    if (bytes.length !== TYPE_SIZE[variable.type]) {
      return WriteStatus.WRONG_SIZE;
    }

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    variable.value = variable.type === TypeCode.F32 ? view.getFloat32(0, true) : view.getUint8(0);
    this.log(`write ${variable.name} = ${variable.value}`);
    return WriteStatus.OK;
  }

  private onRead(reader: LenientReader): void {
    const id = reader.u16();
    const variable = this.variables.at(id);

    if (!reader.valid || !variable) {
      this.sendError(ErrorCode.NO_SUCH_VARIABLE, id);
      return;
    }

    const value = variable.serialize
      ? variable.serialize()
      : writeValue(this.valueOf(variable), variable.type);

    if (value.length > MAX_PAYLOAD_SIZE - 2) {
      this.sendError(ErrorCode.GROUP_TOO_LARGE, id);
      return;
    }

    this.send(MessageType.VALUE, new Writer().u16(id).raw(value).done());
  }

  private onCommand(reader: LenientReader): void {
    const code = reader.u8();
    const argument = reader.u32();

    if (!reader.valid) {
      this.sendError(ErrorCode.MALFORMED, code);
      return;
    }

    this.log(`command ${code} (${argument})`);

    const [result, reason] = this.runCommand(code);

    this.send(MessageType.COMMAND_ACK, new Writer().u8(code).u8(result).u8(reason).done());
  }

  private runCommand(code: number): [CommandResult, Reason] {
    const command = toCommand(code);

    if (command === null) {
      return [CommandResult.UNKNOWN, Reason.NONE];
    }

    if (command === Command.STOP && this.state === RobotState.SAVE) {
      return [CommandResult.DEFERRED, Reason.BUSY_SAVING];
    }

    const refused = refusal(this.state, command);

    if (refused !== null) {
      return [CommandResult.REFUSED, refused];
    }

    this.accept(command);
    return [CommandResult.OK, Reason.NONE];
  }

  private accept(command: Command): void {
    switch (command) {
      case Command.EXPLORE:
      case Command.SOLVE:
        this.enter(RobotState.RUN);
        break;
      case Command.CALIBRATE:
        this.enter(RobotState.CALIBRATE);
        break;
      case Command.SAVE:
        this.enter(RobotState.SAVE);
        break;
      case Command.STOP:
        this.enter(this.state === RobotState.ERROR ? RobotState.ERROR : RobotState.IDLE);
        break;
      case Command.LEAVE_ERROR:
        this.enter(RobotState.IDLE);
        break;
      case Command.RESET:
        break;
    }
  }

  private enter(state: RobotState): void {
    const busySeconds = BUSY_SECONDS[state];

    this.busyUntil = busySeconds === undefined ? 0 : this.now() + busySeconds;

    if (state === this.state) {
      return;
    }

    this.state = state;
    this.publishState();
    this.sendLog(state === RobotState.ERROR ? Severity.ERROR : Severity.INFO, `state ${state}`);
  }

  private advanceState(): void {
    if (this.busyUntil === 0 || this.now() < this.busyUntil) {
      return;
    }

    this.busyUntil = 0;
    this.enter(RobotState.IDLE);
  }

  private publishState(): void {
    this.variable('state').value = STATE_CODES[this.state];
  }

  /**
   * A log is charged to the window like a sample. One the window has no room for is held and sent
   * ahead of the samples once there is; a log that finds another one held is dropped, and counted.
   */
  private sendLog(severity: Severity, text: string): void {
    this.sendHeldLog();

    if (this.heldLog) {
      this.stats.logsDropped++;
      this.variable('link/dropped_logs').value = this.stats.logsDropped;
      return;
    }

    const payload = new Writer()
      .u8(severity)
      .u32(this.timestampUs())
      .raw(new TextEncoder().encode(text).subarray(0, MAX_PAYLOAD_SIZE - LOG_HEADER_SIZE))
      .done();

    if (!this.sendMetered(MessageType.LOG, payload)) {
      this.heldLog = payload;
    }
  }

  private sendHeldLog(): void {
    if (this.heldLog && this.sendMetered(MessageType.LOG, this.heldLog)) {
      this.heldLog = null;
    }
  }

  /**
   * What the robot sends on its own initiative has to fit in the window the application has
   * opened; what it sends in reply is already bounded by the rate of the requests.
   */
  private sendMetered(type: MessageType, payload: Uint8Array): boolean {
    const frame = encodeFrame(type, payload);

    if (!this.window.allows(frame.length)) {
      return false;
    }

    this.window.charge(frame.length);
    this.stats.meteredBytes += frame.length;
    this.refreshCredit();

    if (type === MessageType.SCHEMA_PAGE && this.losesSchemaPage()) {
      this.stats.schemaPagesDropped++;
      return true;
    }

    this.wire.send(frame, true);
    return true;
  }

  private refreshCredit(): void {
    this.variable('link/credit').value = this.window.available;
  }

  private losesSchemaPage(): boolean {
    return this.schemaPagesSent++ === this.faults.dropSchemaPage;
  }

  private send(type: MessageType, payload: Uint8Array): void {
    this.wire.send(encodeFrame(type, payload), false);
  }

  private sendError(code: ErrorCode, context: number): void {
    this.send(MessageType.ERROR, new Writer().u8(code).u16(context).done());
  }
}

/** The entry of a variable in a schema page; only a blob carries a type tag. */
function schemaEntry(variable: Variable): number[] {
  const name = new TextEncoder().encode(variable.name);
  const entry = [variable.type, variable.access, name.length, ...name];

  if (variable.type === TypeCode.BLOB) {
    const tag = new TextEncoder().encode(variable.typeTag ?? '');
    entry.push(tag.length, ...tag);
  }

  return entry;
}
