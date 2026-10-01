/**
 * Mirror of `micras_comm/include/micras/comm/protocol.hpp` in the firmware. Everything on the wire
 * is little endian, which is what both the microcontroller and `DataView` already are.
 *
 * @module
 */

/** The protocol version both ends must agree on in the handshake. */
export const PROTOCOL_VERSION = 2;
/** The largest payload a frame can carry. */
export const MAX_PAYLOAD_SIZE = 200;
/**
 * The largest frame on the wire, delimiter included, as `max_frame_size` in the firmware: the
 * largest payload with its type and check, encoded.
 */
export const MAX_FRAME_SIZE = MAX_PAYLOAD_SIZE + 3 + Math.floor((MAX_PAYLOAD_SIZE + 3) / 254) + 2;
/**
 * The metered bytes the robot may have sent that the monitor has not said it consumed, as
 * `credit_window` in the firmware. Every HELLO opens it again whole.
 */
export const CREDIT_WINDOW = 256;
/** How many stream groups the robot can hold at once. */
export const MAX_GROUPS = 4;
/** How many variables fit in one stream group. */
export const MAX_GROUP_VARIABLES = 16;

/** The first byte of every frame; requests below 0x80, what the robot sends above it. */
export enum MessageType {
  HELLO = 0x01,
  SCHEMA_REQUEST = 0x02,
  GROUP_DEFINE = 0x03,
  GROUP_ENABLE = 0x04,
  CREDIT = 0x05,
  WRITE = 0x06,
  READ = 0x07,
  COMMAND = 0x08,
  PING = 0x09,

  HELLO_ACK = 0x81,
  SCHEMA_PAGE = 0x82,
  GROUP_ACK = 0x83,
  SAMPLE = 0x85,
  WRITE_ACK = 0x86,
  VALUE = 0x87,
  COMMAND_ACK = 0x88,
  PONG = 0x89,
  LOG = 0x8a,
  ERROR = 0x8f,
}

/** The type of a variable, as the schema states it. */
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

/** What the robot answered to a write. */
export enum WriteStatus {
  OK = 0,
  NO_SUCH_ID = 1,
  READ_ONLY = 2,
  NEEDS_IDLE = 3,
  WRONG_SIZE = 4,
}

/** What the robot did with a command, as `CommandResult` in `link.hpp`. */
export enum CommandResult {
  OK = 0,
  UNKNOWN = 1,
  REFUSED = 2,
  /** Accepted, to run once what the robot is busy with ends. */
  DEFERRED = 3,
}

/** Why the robot refused a request it could not act on. */
export enum ErrorCode {
  UNKNOWN_TYPE = 0,
  MALFORMED = 1,
  NO_SUCH_GROUP = 2,
  GROUP_TOO_LARGE = 3,
  NOT_STREAMABLE = 4,
  NO_SUCH_VARIABLE = 5,
}

/** How important a log message from the robot is. */
export enum Severity {
  DEBUG = 0,
  INFO = 1,
  WARNING = 2,
  ERROR = 3,
}

/**
 * What each consumer of the pool is allowed to do with a variable, as the schema spells it out.
 */
export interface Access {
  /** May appear in a stream. */
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

/**
 * Pack access flags into the byte a schema entry carries, as `Access::to_byte` does.
 *
 * @param access The flags.
 * @returns The byte that stands for them.
 */
export function encodeAccess(access: Access): number {
  return (
    Number(access.stream) |
    (Number(access.write) << 1) |
    (Number(access.idle) << 2) |
    (Number(access.persist) << 3)
  );
}
