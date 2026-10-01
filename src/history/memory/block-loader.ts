import type { Block } from '../block';
import type { BlockBacking } from '../block-backing';
import type { BlockAccess } from '../decimation';
import type { Scheduler } from '../scheduler';
import type { BlockMemory } from './block-memory';

/**
 * Reads evicted blocks back from where their copy lives, for the queries.
 *
 * Reads are asked for during a query and started once the scheduler tick ends, after every
 * query of the tick marked the blocks it uses. A read reserves its memory before it starts and
 * never evicts a block used in the same tick, so a working set larger than the cap settles on
 * pyramid answers for what does not fit instead of cycling.
 */
export class BlockLoader implements BlockAccess {
  readonly #memory: BlockMemory;
  readonly #scheduler: Scheduler;
  readonly #maxConcurrentLoads: number;
  readonly #requests = new Set<Block>();
  #tick = 1;
  #tickScheduled = false;
  #activeLoads = 0;

  /**
   * @param memory The memory the blocks come back into.
   * @param scheduler Decides when a query tick ends.
   * @param maxConcurrentLoads How many blocks may be read back at once.
   */
  constructor(memory: BlockMemory, scheduler: Scheduler, maxConcurrentLoads: number) {
    this.#memory = memory;
    this.#scheduler = scheduler;
    this.#maxConcurrentLoads = maxConcurrentLoads;
  }

  /** The current query tick: a block it used is not evicted for a read. */
  get tick(): number {
    return this.#tick;
  }

  /** Start a query: its blocks count as used in the current tick. */
  beginQuery(): void {
    if (this.#tickScheduled) {
      return;
    }

    this.#tickScheduled = true;
    this.#scheduler.schedule(() => this.#endTick());
  }

  /** {@inheritDoc BlockAccess.markUsed} */
  markUsed(block: Block): void {
    block.lastUsed = this.#tick;
  }

  /** {@inheritDoc BlockAccess.request} */
  request(block: Block): void {
    if (!block.resident && !block.loading && block.copy) {
      this.#requests.add(block);
    }
  }

  /** Forget the reads asked for and under way, as the memory forgets every block. */
  reset(): void {
    this.#requests.clear();
    this.#activeLoads = 0;
  }

  #endTick(): void {
    for (const block of this.#requests) {
      if (this.#activeLoads >= this.#maxConcurrentLoads) {
        break;
      }

      this.#startLoad(block);
    }

    this.#requests.clear();
    this.#tickScheduled = false;
    this.#tick++;
  }

  #startLoad(block: Block): void {
    const source = block.copy;

    if (!source || block.resident || block.loading) {
      return;
    }

    const reserved = block.restoredByteLength;

    if (!this.#memory.makeRoom(reserved, true)) {
      return;
    }

    this.#memory.charge(reserved);
    block.loading = true;
    this.#activeLoads++;
    void this.#load(block, source, reserved);
  }

  async #load(block: Block, source: BlockBacking, reserved: number): Promise<void> {
    const resetCount = this.#memory.resetCount;
    let restored = false;

    try {
      const persisted = await source.read(block.ref);

      if (resetCount === this.#memory.resetCount && !block.resident) {
        this.#memory.charge(block.restore(persisted) - reserved);
        block.lastUsed = this.#tick;
        restored = true;
      }
    } catch (error) {
      this.#memory.warn({ type: 'persistence-error', error });
    } finally {
      block.loading = false;

      if (resetCount === this.#memory.resetCount) {
        this.#activeLoads--;

        if (!restored) {
          this.#memory.charge(-reserved);
          this.#memory.noteRoomChanged();
        }

        this.#memory.statusChanged();
      }
    }

    if (restored) {
      this.#memory.ownerOf(block)?.rewritten();
    }
  }
}
