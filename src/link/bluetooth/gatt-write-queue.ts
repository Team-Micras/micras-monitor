import { withTimeout } from '../timeout';

/** Writes one chunk to the characteristic. */
export type ChunkWriter = (chunk: Uint8Array) => Promise<void>;

/** How long one write may take before the queue gives up on it and goes on. */
export const DEFAULT_WRITE_TIMEOUT_MS = 1000;

/**
 * The one queue every write to the characteristic goes through.
 *
 * Chrome refuses a GATT operation while another is in progress, so writes are issued one at a
 * time, each after the previous one settled. Bytes are packed into chunks no larger than one
 * write can carry, filling each chunk across frame boundaries: the robot sees a byte stream and
 * frames are delimited in-band.
 *
 * A write that never settles, as one can on a connection that is going away, costs its timeout and
 * nothing more, and once the queue is cleared for a new connection nothing waits for it at all.
 */
export class GattWriteQueue {
  private queued: Uint8Array[] = [];
  private headOffset = 0;
  private queuedBytes = 0;
  private generation = 0;
  private pumping: number | null = null;

  /**
   * @param write Writes one chunk.
   * @param chunkSize The most bytes one write carries.
   * @param onError Called with a write that failed or timed out; the queue goes on with the next
   * chunk.
   * @param writeTimeoutMs How long one write may take.
   */
  constructor(
    private readonly write: ChunkWriter,
    private readonly chunkSize: number,
    private readonly onError: (error: unknown) => void,
    private readonly writeTimeoutMs: number = DEFAULT_WRITE_TIMEOUT_MS
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

    if (this.pumping !== this.generation) {
      void this.pump(this.generation);
    }
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

  private async pump(generation: number): Promise<void> {
    this.pumping = generation;

    while (this.queued.length > 0 && generation === this.generation) {
      await this.writeOne(this.takeChunk());
    }

    if (this.pumping === generation) {
      this.pumping = null;
    }
  }

  private async writeOne(chunk: Uint8Array): Promise<void> {
    try {
      await withTimeout(this.write(chunk), this.writeTimeoutMs, 'a GATT write');
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
