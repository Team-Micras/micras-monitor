import type { Block } from '../block';
import type { BlockBacking, BlockData } from '../block-backing';
import type { BlockMemory } from './block-memory';

const FIRST_BACKOFF_MS = 1000;
const LAST_BACKOFF_MS = 60_000;

/**
 * Writes the sealed blocks of the memory to a persistence layer while recording: the whole
 * session so far when recording starts, then every block as it seals, and the blocks being
 * filled every few seconds. A block written has a copy, so it may leave memory.
 *
 * A write that fails is tried again once a backoff has passed, doubling from 1 s up to a minute,
 * and the user hears once that writes fail and once that they work again.
 */
export class BlockWriter {
  readonly #memory: BlockMemory;
  readonly #now: () => number;
  readonly #flushIntervalMs: number;
  readonly #writes = new Set<Promise<void>>();
  #target: BlockBacking | undefined;
  #pendingWrites = 0;
  #failing = false;
  #backoffMs = FIRST_BACKOFF_MS;
  #retryAtMs = 0;
  #lastFlushMs = 0;

  /**
   * @param memory The memory whose blocks it writes.
   * @param now Wall time in milliseconds.
   * @param flushIntervalMs How often the blocks being filled are sealed and written.
   */
  constructor(memory: BlockMemory, now: () => number, flushIntervalMs: number) {
    this.#memory = memory;
    this.#now = now;
    this.#flushIntervalMs = flushIntervalMs;
  }

  /** Whether blocks are being written to a persistence layer. */
  get recording(): boolean {
    return this.#target !== undefined;
  }

  /** How many writes are under way. */
  get pendingWrites(): number {
    return this.#pendingWrites;
  }

  /** Whether writes to the persistence layer are failing. */
  get failing(): boolean {
    return this.#failing;
  }

  /**
   * Start writing blocks to a persistence layer: first the whole session so far, the blocks
   * being filled sealed and those evicted read back from where they live, then every block as
   * it seals.
   */
  start(target: BlockBacking): void {
    this.#target = target;
    this.#failing = false;
    this.#backoffMs = FIRST_BACKOFF_MS;
    this.#retryAtMs = 0;
    this.#lastFlushMs = this.#now();
    this.#memory.sealOpenBlocks();
    this.persistSealed();
    void this.#backfill(target);
    this.#memory.reconsiderWarning();
    this.#memory.statusChanged();
  }

  /**
   * Seal and write what is being filled, then stop writing blocks. Blocks already written can
   * still leave memory and come back.
   *
   * @returns A promise that settles once every write under way has.
   */
  stop(): Promise<void> {
    this.#memory.sealOpenBlocks();
    this.#retryAtMs = 0;
    this.persistSealed();
    this.#target = undefined;
    this.#memory.reconsiderWarning();
    this.#memory.statusChanged();
    return Promise.all(this.#writes).then(() => undefined);
  }

  /**
   * While recording, seal and write the blocks being filled once the flush interval has passed,
   * and retry failed writes once their backoff has.
   */
  flushIfDue(): void {
    if (!this.#target) {
      return;
    }

    const now = this.#now();

    if (now - this.#lastFlushMs >= this.#flushIntervalMs) {
      this.#lastFlushMs = now;
      this.#memory.sealOpenBlocks();
      this.persistSealed();
    }
  }

  /** While recording, write every sealed block in memory that has no copy there yet. */
  persistSealed(): void {
    const target = this.#target;

    if (!target || (this.#failing && this.#now() < this.#retryAtMs)) {
      return;
    }

    for (const block of this.#memory.blocks) {
      if (block.sealed && block.resident && block.copy !== target && !block.writing) {
        this.#track(this.#persist(block, target, () => Promise.resolve(block.toPersisted())));
      }
    }
  }

  /** Stop recording and forget the writes under way, as the memory forgets every block. */
  reset(): void {
    this.#pendingWrites = 0;
    this.#writes.clear();
    this.#target = undefined;
    this.#failing = false;
  }

  async #backfill(target: BlockBacking): Promise<void> {
    const evicted = this.#memory.blocks.filter((block) => !block.resident && block.copy !== target);

    await evicted.reduce<Promise<void>>(async (previous, block) => {
      await previous;
      const source = block.copy;

      if (this.#target !== target || !source || block.resident || block.writing) {
        return;
      }

      const write = this.#persist(block, target, () => source.read(block.ref));
      this.#track(write);
      await write;
    }, Promise.resolve());
  }

  #track(write: Promise<void>): void {
    this.#writes.add(write);
    void write.finally(() => this.#writes.delete(write));
  }

  async #persist(
    block: Block,
    target: BlockBacking,
    contents: () => Promise<BlockData>
  ): Promise<void> {
    const resetCount = this.#memory.resetCount;
    block.writing = true;
    this.#pendingWrites++;

    try {
      await target.write(await contents());
      block.copy = target;
      this.#recovered();
    } catch (error) {
      this.#failed(error);
    } finally {
      block.writing = false;

      if (resetCount === this.#memory.resetCount) {
        this.#pendingWrites--;
        this.#memory.noteRoomChanged();
      }
    }

    if (resetCount === this.#memory.resetCount) {
      this.#memory.makeRoom(0, false);
    }
  }

  #failed(error: unknown): void {
    const now = this.#now();

    if (now >= this.#retryAtMs) {
      this.#retryAtMs = now + this.#backoffMs;
      this.#backoffMs = Math.min(LAST_BACKOFF_MS, 2 * this.#backoffMs);
    }

    if (!this.#failing) {
      this.#failing = true;
      this.#memory.warn({ type: 'persistence-error', error });
      this.#memory.statusChanged();
    }
  }

  #recovered(): void {
    this.#backoffMs = FIRST_BACKOFF_MS;

    if (this.#failing) {
      this.#failing = false;
      this.#memory.warn({ type: 'persistence-recovered' });
      this.#memory.statusChanged();
    }
  }
}
