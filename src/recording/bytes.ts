/**
 * Little endian bytes in and out, as the recording format lays them out: numbers, raw bytes and
 * strings as a `u32` byte count and UTF-8.
 *
 * @module
 */

/**
 * Lays bytes out one value after another, growing as needed.
 */
export class ByteWriter {
  #bytes: Uint8Array;
  #view: DataView;
  #offset = 0;

  /**
   * @param size How many bytes to make room for at first.
   */
  constructor(size = 64) {
    this.#bytes = new Uint8Array(size);
    this.#view = new DataView(this.#bytes.buffer);
  }

  /** Add an unsigned byte. */
  u8(value: number): this {
    this.#reserve(1);
    this.#view.setUint8(this.#offset, value);
    this.#offset += 1;
    return this;
  }

  /**
   * Add an unsigned 32 bit integer.
   *
   * @param what What the value is, for the error.
   * @throws If the value is not an integer that fits.
   */
  u32(value: number, what: string): this {
    if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
      throw new RangeError(`${what} must fit an unsigned 32 bit integer, got ${value}`);
    }

    this.#reserve(4);
    this.#view.setUint32(this.#offset, value, true);
    this.#offset += 4;
    return this;
  }

  /** Add a 32 bit float. */
  f32(value: number): this {
    this.#reserve(4);
    this.#view.setFloat32(this.#offset, value, true);
    this.#offset += 4;
    return this;
  }

  /** Add a 64 bit float. */
  f64(value: number): this {
    this.#reserve(8);
    this.#view.setFloat64(this.#offset, value, true);
    this.#offset += 8;
    return this;
  }

  /** Leave some zero bytes. */
  skip(count: number): this {
    this.#reserve(count);
    this.#offset += count;
    return this;
  }

  /** Add bytes as they are. */
  raw(bytes: Uint8Array): this {
    this.#reserve(bytes.byteLength);
    this.#bytes.set(bytes, this.#offset);
    this.#offset += bytes.byteLength;
    return this;
  }

  /** Add a string: its UTF-8 byte count, then the bytes. */
  text(value: string): this {
    const encoded = new TextEncoder().encode(value);
    return this.u32(encoded.byteLength, 'Text length').raw(encoded);
  }

  /** The bytes laid out so far, as a copy. */
  done(): Uint8Array {
    return this.#bytes.slice(0, this.#offset);
  }

  #reserve(count: number): void {
    if (this.#offset + count <= this.#bytes.byteLength) {
      return;
    }

    const grown = new Uint8Array(Math.max(2 * this.#bytes.byteLength, this.#offset + count));
    grown.set(this.#bytes);
    this.#bytes = grown;
    this.#view = new DataView(grown.buffer);
  }
}

/**
 * Reads values back one after another from the payload of a record.
 */
export class ByteReader {
  readonly #bytes: Uint8Array;
  readonly #view: DataView;
  #offset = 0;

  /**
   * @param bytes What to read.
   */
  constructor(bytes: Uint8Array) {
    this.#bytes = bytes;
    this.#view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  /** How many bytes are left. */
  get remaining(): number {
    return this.#bytes.byteLength - this.#offset;
  }

  /** Read an unsigned byte. */
  u8(): number {
    this.#need(1);
    return this.#view.getUint8(this.#offset++);
  }

  /** Read an unsigned 32 bit integer. */
  u32(): number {
    this.#need(4);
    const value = this.#view.getUint32(this.#offset, true);
    this.#offset += 4;
    return value;
  }

  /** Read a 32 bit float. */
  f32(): number {
    this.#need(4);
    const value = this.#view.getFloat32(this.#offset, true);
    this.#offset += 4;
    return value;
  }

  /** Read a 64 bit float. */
  f64(): number {
    this.#need(8);
    const value = this.#view.getFloat64(this.#offset, true);
    this.#offset += 8;
    return value;
  }

  /** Pass over some bytes. */
  skip(count: number): void {
    this.#need(count);
    this.#offset += count;
  }

  /** Read bytes as a copy. */
  raw(count: number): Uint8Array {
    this.#need(count);
    const bytes = this.#bytes.slice(this.#offset, this.#offset + count);
    this.#offset += count;
    return bytes;
  }

  /**
   * Read a string.
   *
   * @throws If its bytes are not UTF-8.
   */
  text(): string {
    return new TextDecoder('utf-8', { fatal: true }).decode(this.raw(this.u32()));
  }

  /**
   * Check that everything was read.
   *
   * @param what What the bytes are, for the error.
   * @throws If bytes are left over.
   */
  end(what: string): void {
    if (this.remaining !== 0) {
      throw new Error(`${what} record has ${this.remaining} bytes left over`);
    }
  }

  #need(count: number): void {
    if (this.#offset + count > this.#bytes.byteLength) {
      throw new Error(`Record ends ${this.#offset + count - this.#bytes.byteLength} bytes early`);
    }
  }
}
