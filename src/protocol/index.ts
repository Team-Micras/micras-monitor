/**
 * The wire layer of `micras_comm`: byte stuffing, frames, message layouts and value codecs.
 *
 * It depends on nothing else in the monitor, so the same code runs in the application, in the
 * simulated robot and in tests.
 *
 * @module
 */

export * as Cobs from './cobs';
export { encodeFrame, FrameReader, Reader, Writer, type Frame } from './frame';
export {
  CommandResult,
  CREDIT_WINDOW,
  decodeAccess,
  encodeAccess,
  ErrorCode,
  MAX_FRAME_SIZE,
  MAX_GROUP_VARIABLES,
  MAX_GROUPS,
  MAX_PAYLOAD_SIZE,
  MessageType,
  PROTOCOL_VERSION,
  Severity,
  TypeCode,
  WriteStatus,
  type Access,
} from './protocol';
export {
  defaultValue,
  readValue,
  TYPE_SIZE,
  typeName,
  validateValue,
  writeValue,
  type Fundamental,
} from './type-codec';
