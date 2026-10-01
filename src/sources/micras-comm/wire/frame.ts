import * as Cobs from './cobs';
import { MAX_FRAME_SIZE, MAX_PAYLOAD_SIZE, MessageType } from './constants';

/**
 * The frame check, matching `fletcher16` in `micras_comm/src/frame.cpp`.
 *
 * It is not protecting against the radio, which has a CRC-24 of its own and retransmits until
 * acknowledged. It covers the two hops BLE never sees: the 8N1 serial port with no parity between
 * the microcontroller and the module, and the module's buffer, which drops runs of bytes with no
 * indication that it did.
 *
 * @param data The bytes to check.
 * @returns The check value.
 */
function fletcher16(data: Uint8Array): number {
  let low = 0;
  let high = 0;

  for (const byte of data) {
    low = (low + byte) % 255;
    high = (high + low) % 255;
  }

  return (high << 8) | low;
}

/**
 * A message that arrived whole and passed the frame check.
 */
export interface Frame {
  /** What the message is. */
  type: MessageType;

  /** The bytes after the type, without the frame check. */
  payload: Uint8Array;
}

/**
 * Append little endian values to a payload.
 */
export class PayloadWriter {
  readonly #bytes: number[] = [];

  /** Append an unsigned byte. */
  u8(value: number): this {
    this.#bytes.push(value & 0xff);
    return this;
  }

  /** Append an unsigned 16 bit integer. */
  u16(value: number): this {
    return this.u8(value).u8(value >> 8);
  }

  /** Append an unsigned 32 bit integer. */
  u32(value: number): this {
    return this.u16(value).u16(value >>> 16);
  }

  /** Append a 32 bit float. */
  f32(value: number): this {
    const buffer = new ArrayBuffer(4);
    new DataView(buffer).setFloat32(0, value, true);
    return this.raw(new Uint8Array(buffer));
  }

  /** Append bytes as they are. */
  raw(value: Uint8Array): this {
    for (const byte of value) {
      this.#bytes.push(byte);
    }

    return this;
  }

  /** The payload written so far. */
  done(): Uint8Array {
    return new Uint8Array(this.#bytes);
  }
}

/**
 * Take little endian values from a payload.
 */
export class PayloadReader {
  readonly #payload: Uint8Array;
  readonly #view: DataView;
  #index = 0;

  /**
   * @param payload The bytes to read, from the first.
   */
  constructor(payload: Uint8Array) {
    this.#payload = payload;
    this.#view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  }

  /** Take an unsigned byte. */
  u8(): number {
    return this.#view.getUint8(this.#index++);
  }

  /** Take an unsigned 16 bit integer. */
  u16(): number {
    const value = this.#view.getUint16(this.#index, true);
    this.#index += 2;
    return value;
  }

  /** Take an unsigned 32 bit integer. */
  u32(): number {
    const value = this.#view.getUint32(this.#index, true);
    this.#index += 4;
    return value;
  }

  /**
   * Take a number of bytes, without copying them.
   *
   * @throws A `RangeError` when fewer are left, as every other read past the end does.
   */
  bytes(count: number): Uint8Array {
    if (count > this.left) {
      throw new RangeError(`${count} bytes asked for, ${this.left} left`);
    }

    const value = this.#payload.subarray(this.#index, this.#index + count);
    this.#index += count;
    return value;
  }

  /** Take a number of bytes as UTF-8 text. */
  text(count: number): string {
    return new TextDecoder().decode(this.bytes(count));
  }

  /** Take everything that is left, without copying it. */
  rest(): Uint8Array {
    return this.#payload.subarray(this.#index);
  }

  /** How many bytes are left to take. */
  get left(): number {
    return this.#payload.length - this.#index;
  }
}

/**
 * Build a complete frame around a payload.
 *
 * @param type The type of the message.
 * @param payload The payload of the message.
 * @returns The bytes to put on the wire, delimiter included.
 */
export function encodeFrame(type: MessageType, payload: Uint8Array): Uint8Array {
  if (payload.length > MAX_PAYLOAD_SIZE) {
    throw new Error(`Payload of ${payload.length} bytes exceeds ${MAX_PAYLOAD_SIZE}`);
  }

  const plain = new Uint8Array(payload.length + 3);
  plain[0] = type;
  plain.set(payload, 1);

  const check = fletcher16(plain.subarray(0, payload.length + 1));
  plain[payload.length + 1] = check & 0xff;
  plain[payload.length + 2] = check >> 8;

  const encoded = Cobs.encode(plain);
  const frame = new Uint8Array(encoded.length + 1);
  frame.set(encoded, 0);
  frame[encoded.length] = Cobs.DELIMITER;

  return frame;
}

/**
 * Recover frames from a stream of bytes.
 *
 * A corrupt or truncated frame costs exactly the bytes up to the next delimiter and never
 * desynchronises the reader, because an encoded frame cannot contain a delimiter. Like the
 * firmware's reader, it holds at most one frame's worth of encoded bytes: a run longer than any
 * frame can be is thrown away whole at the next delimiter instead of growing the buffer.
 */
export class FrameReader {
  #encoded: number[] = [];
  #overrun = false;
  #discardedFrames = 0;

  /**
   * Feed whatever arrived.
   *
   * @param data The bytes taken from the transport.
   * @returns Every whole frame the bytes completed.
   */
  push(data: Uint8Array): Frame[] {
    const frames: Frame[] = [];

    for (const byte of data) {
      if (byte !== Cobs.DELIMITER) {
        this.#take(byte);
        continue;
      }

      const frame = this.#overrun ? null : this.#finish(new Uint8Array(this.#encoded));

      if (frame) {
        frames.push(frame);
      } else if (this.#overrun || this.#encoded.length > 0) {
        this.#discardedFrames++;
      }

      this.#encoded = [];
      this.#overrun = false;
    }

    return frames;
  }

  /**
   * How many frames were thrown away for failing the frame check or for being malformed.
   */
  get discarded(): number {
    return this.#discardedFrames;
  }

  /**
   * Reset the reader, for when the transport reconnects.
   */
  clear(): void {
    this.#encoded = [];
    this.#overrun = false;
  }

  #take(byte: number): void {
    if (this.#encoded.length >= MAX_FRAME_SIZE) {
      this.#overrun = true;
    } else {
      this.#encoded.push(byte);
    }
  }

  #finish(encoded: Uint8Array): Frame | null {
    if (encoded.length === 0) {
      return null;
    }

    const decoded = Cobs.decode(encoded);

    if (!decoded || decoded.length < 3) {
      return null;
    }

    const checked = decoded.subarray(0, decoded.length - 2);
    const expected = decoded[decoded.length - 2] | (decoded[decoded.length - 1] << 8);

    if (fletcher16(checked) !== expected) {
      return null;
    }

    return { type: checked[0] as MessageType, payload: checked.subarray(1) };
  }
}
