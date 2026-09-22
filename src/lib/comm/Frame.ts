import * as Cobs from './Cobs';
import { crc16 } from './Crc';
import { MAX_PAYLOAD_SIZE, MessageType } from './Protocol';

/**
 * A message that arrived whole and passed the frame check.
 */
export interface Frame {
  type: MessageType;
  payload: Uint8Array;
}

/**
 * Append little endian values to a payload.
 */
export class Writer {
  private bytes: number[] = [];

  u8(value: number): this {
    this.bytes.push(value & 0xff);
    return this;
  }

  u16(value: number): this {
    return this.u8(value).u8(value >> 8);
  }

  u32(value: number): this {
    return this.u16(value).u16(value >>> 16);
  }

  f32(value: number): this {
    const buffer = new ArrayBuffer(4);
    new DataView(buffer).setFloat32(0, value, true);
    return this.raw(new Uint8Array(buffer));
  }

  raw(value: Uint8Array): this {
    for (const byte of value) {
      this.bytes.push(byte);
    }

    return this;
  }

  done(): Uint8Array {
    return new Uint8Array(this.bytes);
  }
}

/**
 * Take little endian values from a payload.
 */
export class Reader {
  private view: DataView;
  private index = 0;

  constructor(private readonly payload: Uint8Array) {
    this.view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  }

  u8(): number {
    return this.view.getUint8(this.index++);
  }

  u16(): number {
    const value = this.view.getUint16(this.index, true);
    this.index += 2;
    return value;
  }

  u32(): number {
    const value = this.view.getUint32(this.index, true);
    this.index += 4;
    return value;
  }

  bytes(count: number): Uint8Array {
    const value = this.payload.subarray(this.index, this.index + count);
    this.index += count;
    return value;
  }

  text(count: number): string {
    return new TextDecoder().decode(this.bytes(count));
  }

  rest(): Uint8Array {
    return this.payload.subarray(this.index);
  }

  get left(): number {
    return this.payload.length - this.index;
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

  const check = crc16(plain.subarray(0, payload.length + 1));
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
 * desynchronises the reader, because an encoded frame cannot contain a delimiter.
 */
export class FrameReader {
  private encoded: number[] = [];
  private discardedFrames = 0;

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
        this.encoded.push(byte);
        continue;
      }

      if (this.encoded.length > 0) {
        const frame = this.finish(new Uint8Array(this.encoded));

        if (frame) {
          frames.push(frame);
        } else {
          this.discardedFrames++;
        }
      }

      this.encoded = [];
    }

    return frames;
  }

  /**
   * How many frames were thrown away for failing the frame check or for being malformed.
   */
  get discarded(): number {
    return this.discardedFrames;
  }

  /**
   * Reset the reader, for when the transport reconnects.
   */
  clear(): void {
    this.encoded = [];
  }

  private finish(encoded: Uint8Array): Frame | null {
    const decoded = Cobs.decode(encoded);

    if (!decoded || decoded.length < 3) {
      return null;
    }

    const checked = decoded.subarray(0, decoded.length - 2);
    const expected = decoded[decoded.length - 2] | (decoded[decoded.length - 1] << 8);

    if (crc16(checked) !== expected) {
      return null;
    }

    return { type: checked[0] as MessageType, payload: checked.subarray(1) };
  }
}
