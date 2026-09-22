/**
 * Mirror of `micras_comm/include/micras/comm/protocol.hpp` in the firmware. Everything on the wire
 * is little endian, which is what both the microcontroller and `DataView` already are.
 */

export const PROTOCOL_VERSION = 1;
export const MAX_PAYLOAD_SIZE = 200;
export const MAX_GROUPS = 4;
export const MAX_GROUP_VARIABLES = 16;

export enum MessageType {
  HELLO = 0x01,
  SCHEMA_REQUEST = 0x02,
  GROUP_DEFINE = 0x03,
  GROUP_ENABLE = 0x04,
  CREDIT = 0x05,
  WRITE = 0x06,
  READ = 0x07,
  COMMAND = 0x08,
  TRACE_ARM = 0x09,
  TRACE_READ = 0x0a,
  PING = 0x0b,

  HELLO_ACK = 0x81,
  SCHEMA_PAGE = 0x82,
  GROUP_ACK = 0x83,
  SAMPLE = 0x85,
  WRITE_ACK = 0x86,
  VALUE = 0x87,
  COMMAND_ACK = 0x88,
  LOG = 0x89,
  TRACE_STATUS = 0x8a,
  TRACE_DATA = 0x8b,
  PONG = 0x8c,
  ERROR = 0x8f,
}

export enum TypeCode {
  BOOL = 0,
  U8 = 1,
  I8 = 2,
  U16 = 3,
  I16 = 4,
  U32 = 5,
  I32 = 6,
  U64 = 7,
  I64 = 8,
  F32 = 9,
  F64 = 10,
  BLOB = 11,
}

export enum WriteStatus {
  OK = 0,
  NO_SUCH_ID = 1,
  READ_ONLY = 2,
  NEEDS_IDLE = 3,
  WRONG_SIZE = 4,
}

export enum ErrorCode {
  UNKNOWN_TYPE = 0,
  MALFORMED = 1,
  NO_SUCH_GROUP = 2,
  GROUP_TOO_LARGE = 3,
  NOT_STREAMABLE = 4,
  NO_SUCH_VARIABLE = 5,
  BUSY = 6,
}

export enum Severity {
  DEBUG = 0,
  INFO = 1,
  WARNING = 2,
  ERROR = 3,
}

export enum TriggerType {
  IMMEDIATE = 0,
  COMMAND = 1,
  ABOVE = 2,
  BELOW = 3,
}

export enum TraceState {
  IDLE = 0,
  ARMED = 1,
  TRIGGERED = 2,
  FULL = 3,
}

/**
 * What each consumer of the pool is allowed to do with a variable, as the schema spells it out.
 */
export interface Access {
  /** May appear in a stream or in a trace group. */
  stream: boolean;

  /** May be written over the link. */
  write: boolean;

  /** ...but only while the robot is stopped. */
  idle: boolean;

  /** Is part of the flash image. */
  persist: boolean;
}

/**
 * Unpack the access flags of a schema entry.
 *
 * @param bits The byte the schema carries.
 * @returns The flags it stands for.
 */
export function decodeAccess(bits: number): Access {
  return {
    stream: (bits & 0x01) !== 0,
    write: (bits & 0x02) !== 0,
    idle: (bits & 0x04) !== 0,
    persist: (bits & 0x08) !== 0,
  };
}
