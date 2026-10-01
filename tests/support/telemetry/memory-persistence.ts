import type { BlockPersistence, BlockRef, PersistedBlock } from '@/telemetry/persistence';
import { decodeBlock, encodeBlock } from '@/telemetry/recording';

function keyOf(ref: BlockRef): string {
  return `${ref.epochId}:${ref.index}`;
}

/**
 * A persistence layer that keeps blocks in memory, encoded in the recording format, for tests.
 *
 * Encoding on write means the store can never get its own arrays back, just as with OPFS.
 */
export class MemoryBlockPersistence implements BlockPersistence {
  private readonly blocks = new Map<string, Uint8Array>();

  /** How many blocks were written. */
  writes = 0;

  /** How many blocks were read back. */
  reads = 0;

  /** How many blocks it holds. */
  get size(): number {
    return this.blocks.size;
  }

  /** Whether a block was written. */
  has(ref: BlockRef): boolean {
    return this.blocks.has(keyOf(ref));
  }

  /** {@inheritDoc BlockPersistence.write} */
  write(block: PersistedBlock): Promise<void> {
    this.blocks.set(keyOf(block.ref), encodeBlock(block));
    this.writes++;
    return Promise.resolve();
  }

  /** {@inheritDoc BlockPersistence.read} */
  read(ref: BlockRef): Promise<PersistedBlock> {
    const bytes = this.blocks.get(keyOf(ref));

    if (!bytes) {
      return Promise.reject(new Error(`No block ${ref.index} of epoch ${ref.epochId}`));
    }

    this.reads++;
    return Promise.resolve(decodeBlock(bytes));
  }
}
