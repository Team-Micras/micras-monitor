/**
 * A file that holds a recording: written at positions, read back in slices. The application
 * backs it with the Origin Private File System; {@link MemoryRecordingFile} stands in for tests.
 */
export interface RecordingFile {
  /** How many bytes the file holds. */
  size(): Promise<number>;

  /**
   * Some bytes of the file.
   *
   * @throws If the range goes past the end.
   */
  read(offset: number, length: number): Promise<Uint8Array>;

  /**
   * Write bytes at a position, growing the file if needed. Once the promise resolves the bytes
   * are durable: they survive the tab being killed. A write that failed may have left part of
   * the bytes; writing again at the same position replaces them.
   */
  write(offset: number, bytes: Uint8Array): Promise<void>;

  /** Cut the file to a size, as to drop a damaged tail. */
  truncate(size: number): Promise<void>;

  /** Let go of the file; nothing may be read or written after. */
  close(): Promise<void>;
}

/**
 * A recording file in memory, for tests and for browsers without a file system to write to.
 */
export class MemoryRecordingFile implements RecordingFile {
  private bytes = new Uint8Array(0);
  private length = 0;
  private closed = false;

  /**
   * @param initial What the file holds at first.
   */
  constructor(initial?: Uint8Array) {
    if (initial) {
      this.bytes = initial.slice();
      this.length = initial.byteLength;
    }
  }

  /** Every byte the file holds, as a copy. */
  contents(): Uint8Array {
    return this.bytes.slice(0, this.length);
  }

  /** Whether {@link close} was called. */
  get isClosed(): boolean {
    return this.closed;
  }

  /** {@inheritDoc RecordingFile.size} */
  size(): Promise<number> {
    return Promise.resolve(this.length);
  }

  /** {@inheritDoc RecordingFile.read} */
  read(offset: number, length: number): Promise<Uint8Array> {
    if (offset < 0 || offset + length > this.length) {
      return Promise.reject(
        new RangeError(`Cannot read ${length} bytes at ${offset} of ${this.length}`)
      );
    }

    return Promise.resolve(this.bytes.slice(offset, offset + length));
  }

  /** {@inheritDoc RecordingFile.write} */
  write(offset: number, bytes: Uint8Array): Promise<void> {
    if (this.closed) {
      return Promise.reject(new Error('The recording file is closed'));
    }

    const end = offset + bytes.byteLength;

    if (end > this.bytes.byteLength) {
      const grown = new Uint8Array(Math.max(end, 2 * this.bytes.byteLength));
      grown.set(this.bytes.subarray(0, this.length));
      this.bytes = grown;
    }

    this.bytes.set(bytes, offset);
    this.length = Math.max(this.length, end);
    return Promise.resolve();
  }

  /** {@inheritDoc RecordingFile.truncate} */
  truncate(size: number): Promise<void> {
    this.length = Math.min(this.length, size);
    return Promise.resolve();
  }

  /** {@inheritDoc RecordingFile.close} */
  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }
}
