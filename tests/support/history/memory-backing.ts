import {
  blockKey,
  type BlockBacking,
  type BlockRef,
  type BlockData,
} from '@/history/block-backing';
import { decodeBlock, encodeBlock } from '@/recording/codec';

/**
 * A persistence layer that keeps blocks in memory, encoded in the recording format, for tests.
 *
 * Encoding on write means the store can never get its own arrays back, just as with OPFS.
 */
export class MemoryBlockBacking implements BlockBacking {
  readonly #blocks = new Map<string, Uint8Array>();

  /** How many blocks were written. */
  writes = 0;

  /** How many blocks were read back. */
  reads = 0;

  /** How many blocks it holds. */
  get size(): number {
    return this.#blocks.size;
  }

  /** Whether a block was written. */
  has(ref: BlockRef): boolean {
    return this.#blocks.has(blockKey(ref));
  }

  /** {@inheritDoc BlockBacking.write} */
  write(block: BlockData): Promise<void> {
    this.#blocks.set(blockKey(block.ref), encodeBlock(block));
    this.writes++;
    return Promise.resolve();
  }

  /** {@inheritDoc BlockBacking.read} */
  read(ref: BlockRef): Promise<BlockData> {
    const bytes = this.#blocks.get(blockKey(ref));

    if (!bytes) {
      return Promise.reject(new Error(`No block ${ref.index} of run ${ref.runId}`));
    }

    this.reads++;
    return Promise.resolve(decodeBlock(bytes));
  }
}
