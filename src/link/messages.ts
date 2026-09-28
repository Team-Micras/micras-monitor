/**
 * The layout of each message of protocol version 1, one encoder or decoder per message type.
 *
 * Nothing else in the link knows where a field sits in a payload, so a new protocol version
 * changes the functions of the messages it changes and nothing around them.
 *
 * @module
 */

import {
  encodeFrame,
  ErrorCode,
  MessageType,
  Reader,
  Severity,
  TypeCode,
  Writer,
  WriteStatus,
  type Frame,
} from '../protocol';

/** What the robot answered to a command, matching `CommandResult` in `link.hpp`. */
export enum CommandResult {
  OK = 0,
  UNKNOWN = 1,
  REFUSED = 2,
}

/** What the robot answered to a command. */
export interface CommandReply {
  readonly result: CommandResult;
  /** Why, in the robot's own numbering, where the protocol version carries it. */
  readonly reason: number | null;
}

/** The answer to HELLO: what the robot is and how the session with it works. */
export interface HelloAck {
  type: MessageType.HELLO_ACK;
  version: number;
  schemaHash: number;
  variableCount: number;
  loopTimeUs: number;
  initialCredit: number;
}

/** One variable as a schema page describes it. */
export interface WireSchemaEntry {
  type: TypeCode;
  access: number;
  name: string;
}

/** A run of consecutive schema entries. */
export interface SchemaPage {
  type: MessageType.SCHEMA_PAGE;
  schemaHash: number;
  first: number;
  total: number;
  entries: WireSchemaEntry[];
}

/** The robot's view of a group after a GROUP_DEFINE or a GROUP_ENABLE. */
export interface GroupAck {
  type: MessageType.GROUP_ACK;
  group: number;
  periodTicks: number;
  sampleSize: number;
}

/** One sample of a group. */
export interface Sample {
  type: MessageType.SAMPLE;
  group: number;
  seq: number;
  timestampUs: number;
  values: Uint8Array;
}

/** The answer to WRITE. */
export interface WriteAck {
  type: MessageType.WRITE_ACK;
  variableId: number;
  status: WriteStatus;
}

/** The answer to READ. */
export interface Value {
  type: MessageType.VALUE;
  variableId: number;
  bytes: Uint8Array;
}

/** The answer to COMMAND. */
export interface CommandAck {
  type: MessageType.COMMAND_ACK;
  code: number;
  result: CommandResult;
  /** Why, in the robot's own numbering, where the protocol version carries it. */
  reason: number | null;
}

/** The answer to PING. */
export interface Pong {
  type: MessageType.PONG;
  /** The metered bytes the robot sent since HELLO, where the protocol version carries it. */
  sentTotal: number | null;
}

/** A message the robot logged. */
export interface Log {
  type: MessageType.LOG;
  severity: Severity;
  text: string;
}

/** A request the robot could not act on. */
export interface RobotErrorMessage {
  type: MessageType.ERROR;
  code: ErrorCode;
  context: number;
}

/** Anything the robot sends. */
export type RobotMessage =
  | HelloAck
  | SchemaPage
  | GroupAck
  | Sample
  | WriteAck
  | Value
  | CommandAck
  | Pong
  | Log
  | RobotErrorMessage;

type Decoder = (reader: Reader) => RobotMessage;

const DECODERS: Partial<Record<MessageType, Decoder>> = {
  [MessageType.HELLO_ACK]: decodeHelloAck,
  [MessageType.SCHEMA_PAGE]: decodeSchemaPage,
  [MessageType.GROUP_ACK]: decodeGroupAck,
  [MessageType.SAMPLE]: decodeSample,
  [MessageType.WRITE_ACK]: decodeWriteAck,
  [MessageType.VALUE]: decodeValue,
  [MessageType.COMMAND_ACK]: decodeCommandAck,
  [MessageType.PONG]: () => ({ type: MessageType.PONG, sentTotal: null }),
  [MessageType.LOG]: decodeLog,
  [MessageType.ERROR]: decodeError,
};

/**
 * Read a frame the robot sent.
 *
 * @param frame A frame that passed the frame check.
 * @returns The message, or null when the type is not one the robot sends or the payload is too
 * short for it.
 */
export function decodeMessage(frame: Frame): RobotMessage | null {
  const decode = DECODERS[frame.type];

  if (!decode) {
    return null;
  }

  try {
    return decode(new Reader(frame.payload));
  } catch (error) {
    if (error instanceof RangeError) {
      return null;
    }

    throw error;
  }
}

function decodeHelloAck(reader: Reader): HelloAck {
  return {
    type: MessageType.HELLO_ACK,
    version: reader.u8(),
    schemaHash: reader.u32(),
    variableCount: reader.u16(),
    loopTimeUs: reader.u32(),
    initialCredit: reader.u16(),
  };
}

function decodeSchemaPage(reader: Reader): SchemaPage {
  const schemaHash = reader.u32();
  const first = reader.u16();
  const total = reader.u16();
  const count = reader.u8();
  const entries: WireSchemaEntry[] = [];

  for (let index = 0; index < count; index++) {
    const type: TypeCode = reader.u8();
    const access = reader.u8();
    const length = reader.u8();

    if (reader.left < length) {
      throw new RangeError('Schema entry name runs past the page');
    }

    entries.push({ type, access, name: reader.text(length) });
  }

  return { type: MessageType.SCHEMA_PAGE, schemaHash, first, total, entries };
}

function decodeGroupAck(reader: Reader): GroupAck {
  return {
    type: MessageType.GROUP_ACK,
    group: reader.u8(),
    periodTicks: reader.u16(),
    sampleSize: reader.u16(),
  };
}

function decodeSample(reader: Reader): Sample {
  return {
    type: MessageType.SAMPLE,
    group: reader.u8(),
    seq: reader.u16(),
    timestampUs: reader.u32(),
    values: reader.rest(),
  };
}

function decodeWriteAck(reader: Reader): WriteAck {
  return {
    type: MessageType.WRITE_ACK,
    variableId: reader.u16(),
    status: reader.u8(),
  };
}

function decodeValue(reader: Reader): Value {
  return { type: MessageType.VALUE, variableId: reader.u16(), bytes: reader.rest() };
}

function decodeCommandAck(reader: Reader): CommandAck {
  return {
    type: MessageType.COMMAND_ACK,
    code: reader.u8(),
    result: reader.u8(),
    reason: null,
  };
}

function decodeLog(reader: Reader): Log {
  return { type: MessageType.LOG, severity: reader.u8(), text: reader.text(reader.left) };
}

function decodeError(reader: Reader): RobotErrorMessage {
  return { type: MessageType.ERROR, code: reader.u8(), context: reader.u16() };
}

const EMPTY = new Uint8Array(0);

/** HELLO: start a session, which resets the robot's groups and credit window. */
export function encodeHello(): Uint8Array {
  return encodeFrame(MessageType.HELLO, EMPTY);
}

/** SCHEMA_REQUEST: send the schema from an entry to the end. */
export function encodeSchemaRequest(first: number): Uint8Array {
  return encodeFrame(MessageType.SCHEMA_REQUEST, new Writer().u16(first).done());
}

/** GROUP_DEFINE: replace a group, which leaves it disabled with its sequence back at zero. */
export function encodeGroupDefine(
  group: number,
  periodTicks: number,
  variableIds: readonly number[]
): Uint8Array {
  const writer = new Writer().u8(group).u16(periodTicks).u8(variableIds.length);

  for (const id of variableIds) {
    writer.u16(id);
  }

  return encodeFrame(MessageType.GROUP_DEFINE, writer.done());
}

/** GROUP_ENABLE: start or stop sending a defined group. */
export function encodeGroupEnable(group: number, enabled: boolean): Uint8Array {
  return encodeFrame(
    MessageType.GROUP_ENABLE,
    new Writer()
      .u8(group)
      .u8(enabled ? 1 : 0)
      .done()
  );
}

/** The payload of a CREDIT, which allows the robot to send more metered bytes: a delta in version 1. */
export function creditPayload(bytes: number): Uint8Array {
  return new Writer().u16(bytes).done();
}

/** CREDIT, around its payload. */
export function encodeCredit(payload: Uint8Array): Uint8Array {
  return encodeFrame(MessageType.CREDIT, payload);
}

/** The largest delta one CREDIT carries. */
export const MAX_CREDIT_DELTA = 0xffff;

/** WRITE: set a variable. */
export function encodeWrite(variableId: number, bytes: Uint8Array): Uint8Array {
  return encodeFrame(MessageType.WRITE, new Writer().u16(variableId).raw(bytes).done());
}

/** READ: ask for the current value of a variable. */
export function encodeRead(variableId: number): Uint8Array {
  return encodeFrame(MessageType.READ, new Writer().u16(variableId).done());
}

/** COMMAND: ask the robot to act once. */
export function encodeCommand(code: number, argument: number): Uint8Array {
  return encodeFrame(MessageType.COMMAND, new Writer().u8(code).u32(argument).done());
}

/** PING: ask for a PONG, which proves the robot is still there. */
export function encodePing(): Uint8Array {
  return encodeFrame(MessageType.PING, EMPTY);
}
