/**
 * A robot that speaks the protocol, so that the whole application can be developed and debugged
 * before a radio module is plugged into anything.
 *
 * It implements the same session as `micras_comm`: the handshake, a paged schema, coherent groups
 * at whatever period is asked for, the credit window, writes with their acknowledgements and
 * commands. The signals are made up; everything around them is not.
 *
 * @module
 */

import {
  encodeFrame,
  ErrorCode,
  FrameReader,
  MAX_GROUPS,
  MAX_GROUP_VARIABLES,
  MAX_PAYLOAD_SIZE,
  MessageType,
  PROTOCOL_VERSION,
  Reader,
  TYPE_SIZE,
  TypeCode,
  Writer,
  WriteStatus,
  writeValue,
} from '../../src/protocol';
import type { FaultOptions, RobotStats } from './faults';
import {
  ACCESS_IDLE,
  ACCESS_STREAM,
  ACCESS_WRITE,
  createVariables,
  INITIAL_CREDIT,
  schemaHash,
  type Variable,
} from './variables';
import type { Wire } from './wire';

/** The period of the firmware's control loop. */
export const LOOP_TIME_US = 125;

const SAMPLE_HEADER_SIZE = 7;

interface Group {
  ids: number[];
  period: number;
  sampleSize: number;
  enabled: boolean;
  counter: number;
  sequence: number;
}

/** One simulated robot, on one connection. */
export class Robot {
  private readonly reader = new FrameReader();
  private variables: Variable[] = createVariables();
  private groups: (Group | undefined)[] = [];
  private credit = INITIAL_CREDIT;
  private schemaIndex = 0;
  private schemaPagesSent = 0;
  private iteration = 0;
  private idle = true;
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

  /** Start over as if power cycled, keeping the radio connected. */
  reboot(): void {
    this.stats.reboots++;
    this.log('rebooting');
    this.boot();
  }

  /** One control loop iteration. */
  tick(): void {
    this.iteration++;

    for (let index = 0; index < MAX_GROUPS; index++) {
      this.pumpGroup(index);
    }
  }

  /** Take bytes from the radio. */
  receive(data: Uint8Array): void {
    for (const frame of this.reader.push(data)) {
      this.consume(frame.type, frame.payload);
    }
  }

  /** The schema is paged, because a kilobyte is half a second of a link this slow. */
  sendSchemaPage(): void {
    if (this.schemaIndex >= this.variables.length) {
      return;
    }

    const writer = new Writer()
      .u32(this.schemaHash)
      .u16(this.schemaIndex)
      .u16(this.variables.length)
      .u8(0);
    const header = writer.done();
    const entries: number[] = [];
    let index = this.schemaIndex;
    let count = 0;

    while (index < this.variables.length) {
      const name = new TextEncoder().encode(this.variables[index].name);

      if (header.length + entries.length + name.length + 3 > MAX_PAYLOAD_SIZE) {
        break;
      }

      entries.push(this.variables[index].type, this.variables[index].access, name.length, ...name);
      index++;
      count++;
    }

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

  private boot(): void {
    this.variables = createVariables();
    this.groups = Array.from({ length: MAX_GROUPS }, () => undefined);
    this.credit = INITIAL_CREDIT;
    this.schemaIndex = this.variables.length;
    this.iteration = 0;
    this.idle = true;
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
      .u16(group.sequence++ & 0xffff)
      .u32((this.iteration * LOOP_TIME_US) >>> 0)
      .raw(this.sampleGroup(group))
      .done();

    if (this.sendMetered(MessageType.SAMPLE, payload)) {
      this.stats.samplesSent++;
    } else {
      this.stats.samplesDropped++;
      this.variable('link/dropped_samples').value = this.stats.samplesDropped;
    }
  }

  private now(): number {
    return (this.iteration * LOOP_TIME_US) / 1e6;
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

  private consume(type: MessageType, payload: Uint8Array): void {
    try {
      this.execute(type, new Reader(payload));
    } catch (error) {
      if (!(error instanceof RangeError)) {
        throw error;
      }

      this.sendError(ErrorCode.MALFORMED, type);
    }
  }

  private execute(type: MessageType, reader: Reader): void {
    switch (type) {
      case MessageType.PING:
        this.send(MessageType.PONG, new Uint8Array(0));
        break;
      case MessageType.HELLO:
        this.onHello();
        break;
      case MessageType.SCHEMA_REQUEST:
        this.schemaIndex = Math.min(reader.u16(), this.variables.length);
        break;
      case MessageType.GROUP_DEFINE:
        this.onGroupDefine(reader);
        break;
      case MessageType.GROUP_ENABLE:
        this.onGroupEnable(reader);
        break;
      case MessageType.CREDIT:
        this.onCredit(reader.u16());
        break;
      case MessageType.WRITE:
        this.onWrite(reader);
        break;
      case MessageType.READ:
        this.onRead(reader.u16());
        break;
      case MessageType.COMMAND:
        this.onCommand(reader.u8(), reader.u32());
        break;
      default:
        this.sendError(ErrorCode.UNKNOWN_TYPE, type);
        break;
    }
  }

  private onHello(): void {
    this.stats.hellos++;
    this.groups.fill(undefined);
    this.credit = INITIAL_CREDIT;
    this.schemaIndex = this.variables.length;
    this.send(
      MessageType.HELLO_ACK,
      new Writer()
        .u8(PROTOCOL_VERSION)
        .u32(this.schemaHash)
        .u16(this.variables.length)
        .u32(LOOP_TIME_US)
        .u16(INITIAL_CREDIT)
        .done()
    );
  }

  private onGroupDefine(reader: Reader): void {
    const index = reader.u8();
    const period = Math.max(1, reader.u16());
    const count = reader.u8();
    const ids = Array.from({ length: count }, () => reader.u16());

    if (index >= MAX_GROUPS) {
      this.sendError(ErrorCode.NO_SUCH_GROUP, index);
      return;
    }

    if (count > MAX_GROUP_VARIABLES) {
      this.sendError(ErrorCode.GROUP_TOO_LARGE, count);
      return;
    }

    const missing = ids.find((id) => id >= this.variables.length);

    if (missing !== undefined) {
      this.sendError(ErrorCode.NO_SUCH_VARIABLE, missing);
      return;
    }

    const unstreamable = ids.find((id) => (this.variables[id].access & ACCESS_STREAM) === 0);

    if (unstreamable !== undefined) {
      this.sendError(ErrorCode.NOT_STREAMABLE, unstreamable);
      return;
    }

    const sampleSize = ids.reduce((total, id) => total + TYPE_SIZE[this.variables[id].type], 0);

    if (sampleSize + SAMPLE_HEADER_SIZE > MAX_PAYLOAD_SIZE) {
      this.sendError(ErrorCode.GROUP_TOO_LARGE, sampleSize);
      return;
    }

    this.groups[index] = { ids, period, sampleSize, enabled: false, counter: 0, sequence: 0 };
    this.sendGroupAck(index, period, sampleSize);
  }

  private onGroupEnable(reader: Reader): void {
    const index = reader.u8();
    const enable = reader.u8() !== 0;
    const group = this.groups[index];

    if (!group || group.ids.length === 0) {
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

  private onCredit(bytes: number): void {
    if (this.creditsToDrop > 0 && this.stats.samplesSent > 0) {
      this.creditsToDrop--;
      this.stats.creditFramesDropped++;
      return;
    }

    this.stats.creditReceived += bytes;
    this.credit = Math.min(this.credit + bytes, INITIAL_CREDIT);
    this.variable('link/credit').value = this.credit;
  }

  private onWrite(reader: Reader): void {
    const id = reader.u16();
    const bytes = reader.rest();
    const status = this.write(id, bytes);

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

    if ((variable.access & ACCESS_IDLE) !== 0 && !this.idle) {
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

  private onRead(id: number): void {
    const variable = this.variables.at(id);

    if (!variable) {
      this.sendError(ErrorCode.NO_SUCH_VARIABLE, id);
      return;
    }

    this.send(
      MessageType.VALUE,
      new Writer()
        .u16(id)
        .raw(writeValue(this.valueOf(variable), variable.type))
        .done()
    );
  }

  private onCommand(code: number, argument: number): void {
    this.log(`command ${code} (${argument})`);

    this.idle = code !== 0 && code !== 1;
    this.send(MessageType.COMMAND_ACK, new Writer().u8(code).u8(0).done());
    this.send(
      MessageType.LOG,
      new Writer()
        .u8(1)
        .raw(new TextEncoder().encode(`ran command ${code}`))
        .done()
    );
  }

  /**
   * What the robot sends on its own initiative has to fit in the window the application has
   * opened; what it sends in reply is already bounded by the rate of the requests.
   */
  private sendMetered(type: MessageType, payload: Uint8Array): boolean {
    const frame = encodeFrame(type, payload);

    if (this.credit < frame.length) {
      return false;
    }

    this.credit -= frame.length;
    this.stats.meteredBytes += frame.length;
    this.variable('link/credit').value = this.credit;

    if (type === MessageType.SCHEMA_PAGE && this.losesSchemaPage()) {
      this.stats.schemaPagesDropped++;
      return true;
    }

    this.wire.send(frame, true);
    return true;
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
