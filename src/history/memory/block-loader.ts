import type { Block } from '../block';

/**
 * Keeps count of what the queries ask back into memory: the query tick, the evicted blocks asked
 * for during it and how many reads are under way. {@link BlockMemory} starts the reads when the
 * tick ends and tells it when each ends.
 */
export class BlockLoader {
  readonly #maxConcurrentLoads: number;
  readonly #requests = new Set<Block>();
  #tick = 1;
  #activeLoads = 0;

  /**
   * @param maxConcurrentLoads How many blocks may be read back at once.
   */
  constructor(maxConcurrentLoads: number) {
    this.#maxConcurrentLoads = maxConcurrentLoads;
  }

  /** The current query tick: a block it used is not evicted for a read. */
  get tick(): number {
    return this.#tick;
  }

  /** The blocks asked back during the tick, in the order they were asked for. */
  get requested(): ReadonlySet<Block> {
    return this.#requests;
  }

  /** Whether another read may start. */
  get canStart(): boolean {
    return this.#activeLoads < this.#maxConcurrentLoads;
  }

  /** Count a block as used by the current query tick. */
  markUsed(block: Block): void {
    block.lastUsed = this.#tick;
  }

  /** Ask for an evicted block with a copy to come back once the tick ends. */
  request(block: Block): void {
    if (!block.resident && !block.loading && block.copy) {
      this.#requests.add(block);
    }
  }

  /** Forget what was asked for, and start a new tick. */
  endTick(): void {
    this.#requests.clear();
    this.#tick++;
  }

  /** A read of a block started. */
  started(block: Block): void {
    block.loading = true;
    this.#activeLoads++;
  }

  /**
   * A read of a block ended.
   *
   * @param current Whether the memory was not reset since it started.
   */
  ended(block: Block, current: boolean): void {
    block.loading = false;

    if (current) {
      this.#activeLoads--;
    }
  }

  /** Forget the reads asked for and under way, as the memory forgets every block. */
  reset(): void {
    this.#requests.clear();
    this.#activeLoads = 0;
  }
}
