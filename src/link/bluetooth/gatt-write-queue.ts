/** Writes one chunk to the characteristic. */
export type ChunkWriter = (chunk: Uint8Array) => Promise<void>;

/**
 * The one queue every write to the characteristic goes through.
 *
 * Chrome refuses a GATT operation while another is in progress, so writes are issued one at a
 * time, each after the previous one settled. Bytes are packed into chunks no larger than one
 * write can carry, filling each chunk across frame boundaries: the robot sees a byte stream and
 * frames are delimited in-band.
 */
export class GattWriteQueue {
  private queued: Uint8Array[] = [];
  private headOffset = 0;
  private queuedBytes = 0;
  private writing = false;
  private generation = 0;

  /**
   * @param write Writes one chunk.
   * @param chunkSize The most bytes one write carries.
   * @param onError Called with a write that failed; the queue goes on with the next chunk.
   */
  constructor(
    private readonly write: ChunkWriter,
    private readonly chunkSize: number,
    private readonly onError: (error: unknown) => void
  ) {
    if (!Number.isInteger(chunkSize) || chunkSize < 1) {
      throw new Error(`Chunk size must be a positive integer, got ${chunkSize}`);
    }
  }

  /**
   * Queue bytes to be written after everything already queued.
   *
   * @param bytes The bytes; they are copied, so the caller may reuse the buffer.
   */
  push(bytes: Uint8Array): void {
    if (bytes.length === 0) {
      return;
    }

    this.queued.push(bytes.slice());
    this.queuedBytes += bytes.length;
    void this.pump();
  }

  /**
   * Drop everything not yet written. A write already in flight completes, but nothing follows it.
   */
  clear(): void {
    this.queued = [];
    this.headOffset = 0;
    this.queuedBytes = 0;
    this.generation++;
  }

  /** How many bytes are waiting to be written. */
  get pending(): number {
    return this.queuedBytes;
  }

  private async pump(): Promise<void> {
    if (this.writing) {
      return;
    }

    this.writing = true;
    await this.writeFrom(this.generation);
    this.writing = false;

    if (this.queued.length > 0) {
      void this.pump();
    }
  }

  private async writeFrom(generation: number): Promise<void> {
    if (this.queued.length === 0 || generation !== this.generation) {
      return;
    }

    await this.writeOne(this.takeChunk());
    return this.writeFrom(generation);
  }

  private async writeOne(chunk: Uint8Array): Promise<void> {
    try {
      await this.write(chunk);
    } catch (error) {
      this.onError(error);
    }
  }

  private takeChunk(): Uint8Array {
    const chunk = new Uint8Array(Math.min(this.chunkSize, this.queuedBytes));
    let filled = 0;

    this.queuedBytes -= chunk.length;

    while (filled < chunk.length) {
      const head = this.queued[0];
      const taken = head.subarray(this.headOffset, this.headOffset + chunk.length - filled);
      chunk.set(taken, filled);
      filled += taken.length;
      this.headOffset += taken.length;

      if (this.headOffset === head.length) {
        this.queued.shift();
        this.headOffset = 0;
      }
    }

    return chunk;
  }
}
