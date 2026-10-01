import type { Emitter } from '@/core/emitter';

import { Block, type BlockLayout } from '../block';
import type { BlockBacking, BlockData } from '../block-backing';
import type { BlockAccess } from '../decimation';
import type { Scheduler } from '../scheduler';
import type { ChangeSignal } from '../tick-notifier';
import type { StoreStatus, StoreWarning } from '../types';
import { BlockLoader } from './block-loader';
import { BlockWriter } from './block-writer';

/**
 * What the block memory needs of the run that owns blocks.
 */
export interface BlockOwner {
  /** Whether the run takes no more samples. */
  readonly closed: boolean;

  /** Seal the block being filled, if it holds anything. */
  sealOpenBlock(): void;

  /** One of its blocks left memory or came back: its readers must look again. */
  rewritten(): void;

  /** One of its sealed blocks was let go of for good. */
  dropBlock(block: Block): void;
}

/**
 * How to set up the block memory.
 */
export interface BlockMemoryOptions {
  /** The most memory blocks and gap records may take. */
  readonly capBytes: number;

  /** The share of the cap at which to warn. */
  readonly warningRatio: number;

  /** Decides when a query tick ends; the one the store notifies on. */
  readonly scheduler: Scheduler;

  /** Wall time in milliseconds. */
  readonly now: () => number;

  /** How often, while recording, the blocks being filled are sealed and written. */
  readonly flushIntervalMs: number;

  /** How many blocks may be read back at once. */
  readonly maxConcurrentLoads: number;

  /** The runs by id, in the order they opened, which own the blocks. */
  readonly owners: ReadonlyMap<number, BlockOwner>;

  /** Where the warnings go. */
  readonly warnings: Emitter<{ warning: StoreWarning }>;

  /** Touched whenever {@link BlockMemory.status} changes. */
  readonly statusSignal: ChangeSignal;
}

/**
 * Decides which blocks hold their samples in memory, under a memory cap.
 *
 * - While recording, every sealed block is written to the persistence layer, and the blocks
 *   being filled are sealed and written every few seconds, so that little is lost if the tab
 *   dies. A block with a copy can leave memory when room is needed, least recently read first,
 *   and comes back when a query needs its raw samples. While a write is under way the blocks may
 *   go one block over the cap, rather than lose samples to the write's latency. If nothing can
 *   leave, new samples stop being kept until room comes back.
 * - While not recording, the live view never stops: at the cap, the oldest sealed blocks without
 *   a copy are let go of, and their stretch becomes a gap of samples not stored.
 *
 * Reads are asked for during a query and started once the scheduler tick ends, after every
 * query of the tick marked the blocks it uses. A read reserves its memory before it starts and
 * never evicts a block used in the same tick, so a working set larger than the cap settles on
 * pyramid answers for what does not fit instead of cycling.
 *
 * The warning comes at a share of the cap: of all the memory while not recording, and of the
 * memory nothing can free, the pyramids, leaf times and gap records, while recording.
 */
export class BlockMemory implements BlockAccess {
  readonly #capBytes: number;
  readonly #warningRatio: number;
  readonly #scheduler: Scheduler;
  readonly #owners: ReadonlyMap<number, BlockOwner>;
  readonly #warnings: Emitter<{ warning: StoreWarning }>;
  readonly #statusSignal: ChangeSignal;
  readonly #loader: BlockLoader;
  readonly #writer: BlockWriter;
  #blocks: Block[] = [];
  #usedBytes = 0;
  #fixedBytes = 0;
  #historyStopped = false;
  #roomChanged = false;
  #warned = false;
  #tickScheduled = false;
  #resetCount = 0;
  #status: StoreStatus | undefined;

  /**
   * @param options The cap, the clock, the owners and where to report.
   */
  constructor(options: BlockMemoryOptions) {
    this.#capBytes = options.capBytes;
    this.#warningRatio = options.warningRatio;
    this.#scheduler = options.scheduler;
    this.#owners = options.owners;
    this.#warnings = options.warnings;
    this.#statusSignal = options.statusSignal;
    this.#loader = new BlockLoader(options.maxConcurrentLoads);
    this.#writer = new BlockWriter(options.now, options.flushIntervalMs);
  }

  /** The memory the blocks take and what is recording; the same object until it changes. */
  status(): StoreStatus {
    this.#status ??= this.#snapshot();
    return this.#status;
  }

  /**
   * A new block, or undefined if the memory cap does not allow one. While stopped, it only tries
   * again once something freed memory, and asks for room for two blocks before resuming.
   */
  allocate(layout: BlockLayout): Block | undefined {
    if (this.#historyStopped && !this.#roomChanged) {
      return undefined;
    }

    this.#roomChanged = false;
    const bytes = Block.byteLengthFor(layout);
    const fits = this.#makeRoom(this.#historyStopped ? 2 * bytes : bytes, false);
    const overdraft = this.#writer.pendingWrites > 0 && this.#usedBytes <= this.#capBytes;

    if (!fits && !overdraft) {
      this.#stopHistory();
      return undefined;
    }

    const block = new Block(layout);
    this.#blocks.push(block);
    this.#usedBytes += bytes;
    this.#fixedBytes += block.indexByteLength;

    if (this.#historyStopped) {
      this.#historyStopped = false;
      this.#warn({ type: 'history-resumed' });
    }

    this.#checkWarning();
    this.#statusChanged();
    return block;
  }

  /** A block takes no more samples: compact it if it did not fill, and write it if recording. */
  seal(block: Block): void {
    block.seal();
    const indexBefore = block.indexByteLength;
    const freed = block.compact();
    this.#usedBytes -= freed;
    this.#fixedBytes += block.indexByteLength - indexBefore;

    if (freed !== 0) {
      this.#statusChanged();
    }

    this.#persistSealed();
  }

  /**
   * A block restored from a recording already has a copy there: it can leave memory at once, and
   * comes back from the recording when a query needs it.
   */
  adopt(block: Block, source: BlockBacking): void {
    block.copy = source;
    this.#roomChanged = true;
    this.#makeRoom(0, false);
  }

  /** Memory outside the blocks, which never leaves, was taken, or given back when negative. */
  account(bytes: number): void {
    this.#usedBytes += bytes;
    this.#fixedBytes += bytes;
    this.#checkWarning();
    this.#statusChanged();
  }

  /** Forget every block and stop recording, as for a new session. */
  reset(): void {
    this.#resetCount++;
    this.#blocks = [];
    this.#usedBytes = 0;
    this.#fixedBytes = 0;
    this.#historyStopped = false;
    this.#roomChanged = true;
    this.#warned = false;
    this.#loader.reset();
    this.#writer.reset();
    this.#statusChanged();
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
    this.#loader.markUsed(block);
  }

  /** {@inheritDoc BlockAccess.request} */
  request(block: Block): void {
    this.#loader.request(block);
  }

  /**
   * Start writing blocks to a persistence layer: first the whole session so far, the blocks
   * being filled sealed and those evicted read back from where they live, then every block as
   * it seals.
   */
  startRecording(target: BlockBacking): void {
    this.#writer.start(target);
    this.#sealOpenBlocks();
    this.#persistSealed();
    void this.#backfill(target);
    this.#reconsiderWarning();
    this.#statusChanged();
  }

  /**
   * Seal and write what is being filled, then stop writing blocks. Blocks already written can
   * still leave memory and come back.
   *
   * @returns A promise that settles once every write under way has.
   */
  stopRecording(): Promise<void> {
    this.#sealOpenBlocks();
    this.#writer.retryNow();
    this.#persistSealed();
    const written = this.#writer.stop();
    this.#reconsiderWarning();
    this.#statusChanged();
    return written;
  }

  /**
   * While recording, seal and write the blocks being filled once the flush interval has passed,
   * and retry failed writes once their backoff has.
   */
  flushIfDue(): void {
    if (this.#writer.flushDue()) {
      this.#sealOpenBlocks();
      this.#persistSealed();
    }
  }

  #snapshot(): StoreStatus {
    let residentBlocks = 0;

    for (const block of this.#blocks) {
      if (block.resident) {
        residentBlocks++;
      }
    }

    return {
      usedBytes: this.#usedBytes,
      capBytes: this.#capBytes,
      historyStopped: this.#historyStopped,
      recording: this.#writer.target !== undefined,
      persistenceFailing: this.#writer.failing,
      residentBlocks,
      evictedBlocks: this.#blocks.length - residentBlocks,
    };
  }

  #statusChanged(): void {
    this.#status = undefined;
    this.#statusSignal.touch();
  }

  #warn(warning: StoreWarning): void {
    this.#warnings.emit('warning', warning);
  }

  #sealOpenBlocks(): void {
    for (const owner of this.#owners.values()) {
      if (!owner.closed) {
        owner.sealOpenBlock();
      }
    }
  }

  #endTick(): void {
    for (const block of this.#loader.requested) {
      if (!this.#loader.canStart) {
        break;
      }

      this.#startLoad(block);
    }

    this.#loader.endTick();
    this.#tickScheduled = false;
  }

  #startLoad(block: Block): void {
    const source = block.copy;

    if (!source || block.resident || block.loading) {
      return;
    }

    const reserved = block.restoredByteLength;

    if (!this.#makeRoom(reserved, true)) {
      return;
    }

    this.#usedBytes += reserved;
    this.#status = undefined;
    this.#loader.started(block);
    void this.#load(block, source, reserved);
  }

  async #load(block: Block, source: BlockBacking, reserved: number): Promise<void> {
    const resetCount = this.#resetCount;
    let restored = false;

    try {
      const persisted = await source.read(block.ref);

      if (resetCount === this.#resetCount && !block.resident) {
        this.#usedBytes += block.restore(persisted) - reserved;
        block.lastUsed = this.#loader.tick;
        restored = true;
      }
    } catch (error) {
      this.#warn({ type: 'persistence-error', error });
    } finally {
      const current = resetCount === this.#resetCount;
      this.#loader.ended(block, current);

      if (current) {
        if (!restored) {
          this.#usedBytes -= reserved;
          this.#roomChanged = true;
        }

        this.#statusChanged();
      }
    }

    if (restored) {
      this.#owners.get(block.ref.runId)?.rewritten();
    }
  }

  #persistSealed(): void {
    const target = this.#writer.target;

    if (!target || !this.#writer.canWrite) {
      return;
    }

    for (const block of this.#blocks) {
      if (block.sealed && block.resident && block.copy !== target && !block.writing) {
        this.#writer.track(
          this.#persist(block, target, () => Promise.resolve(block.toPersisted()))
        );
      }
    }
  }

  async #backfill(target: BlockBacking): Promise<void> {
    const evicted = this.#blocks.filter((block) => !block.resident && block.copy !== target);

    await evicted.reduce<Promise<void>>(async (previous, block) => {
      await previous;
      const source = block.copy;

      if (this.#writer.target !== target || !source || block.resident || block.writing) {
        return;
      }

      const write = this.#persist(block, target, () => source.read(block.ref));
      this.#writer.track(write);
      await write;
    }, Promise.resolve());
  }

  async #persist(
    block: Block,
    target: BlockBacking,
    contents: () => Promise<BlockData>
  ): Promise<void> {
    const resetCount = this.#resetCount;
    this.#writer.began(block);

    try {
      await target.write(await contents());
      block.copy = target;

      if (this.#writer.recovered()) {
        this.#warn({ type: 'persistence-recovered' });
        this.#statusChanged();
      }
    } catch (error) {
      if (this.#writer.failed()) {
        this.#warn({ type: 'persistence-error', error });
        this.#statusChanged();
      }
    } finally {
      const current = resetCount === this.#resetCount;
      this.#writer.ended(block, current);

      if (current) {
        this.#roomChanged = true;
      }
    }

    if (resetCount === this.#resetCount) {
      this.#makeRoom(0, false);
    }
  }

  #makeRoom(bytes: number, forLoad: boolean): boolean {
    if (forLoad && this.#usedBytes - this.#evictableBytes() + bytes > this.#capBytes) {
      return false;
    }

    let changed = false;

    while (this.#usedBytes + bytes > this.#capBytes) {
      const victim = this.#evictable(forLoad);

      if (victim) {
        this.#usedBytes -= victim.evict();
        this.#owners.get(victim.ref.runId)?.rewritten();
        changed = true;
        continue;
      }

      const oldest = forLoad || this.#writer.target ? undefined : this.#droppable();

      if (!oldest) {
        break;
      }

      this.#drop(oldest);
      changed = true;
    }

    if (changed) {
      this.#roomChanged = true;
      this.#statusChanged();
    }

    return this.#usedBytes + bytes <= this.#capBytes;
  }

  #stopHistory(): void {
    if (this.#historyStopped) {
      return;
    }

    this.#historyStopped = true;
    this.#warn({ type: 'history-stopped', usedBytes: this.#usedBytes, capBytes: this.#capBytes });
    this.#statusChanged();
  }

  #evictable(forLoad: boolean): Block | undefined {
    let victim: Block | undefined;

    for (const block of this.#blocks) {
      if (this.#canEvict(block, forLoad) && (!victim || block.lastUsed < victim.lastUsed)) {
        victim = block;
      }
    }

    return victim;
  }

  #evictableBytes(): number {
    let bytes = 0;

    for (const block of this.#blocks) {
      if (this.#canEvict(block, true)) {
        bytes += block.rawByteLength;
      }
    }

    return bytes;
  }

  #canEvict(block: Block, forLoad: boolean): boolean {
    return (
      block.resident &&
      block.copy !== undefined &&
      !block.writing &&
      !block.loading &&
      !(forLoad && block.lastUsed === this.#loader.tick)
    );
  }

  #droppable(): Block | undefined {
    return this.#blocks.find(
      (block) => block.sealed && block.resident && !block.copy && !block.writing
    );
  }

  #drop(block: Block): void {
    this.#blocks.splice(this.#blocks.indexOf(block), 1);
    this.#usedBytes -= block.rawByteLength + block.indexByteLength;
    this.#fixedBytes -= block.indexByteLength;
    this.#owners.get(block.ref.runId)?.dropBlock(block);
    this.#warn({
      type: 'history-dropped',
      untilUs: block.lastTimeUs,
      usedBytes: this.#usedBytes,
      capBytes: this.#capBytes,
    });
  }

  #reconsiderWarning(): void {
    this.#warned = false;
    this.#checkWarning();
  }

  #checkWarning(): void {
    const pressure = this.#writer.target ? this.#fixedBytes : this.#usedBytes;

    if (pressure < this.#capBytes * this.#warningRatio) {
      this.#warned = false;
      return;
    }

    if (this.#warned) {
      return;
    }

    this.#warned = true;
    this.#warn({ type: 'memory-warning', usedBytes: this.#usedBytes, capBytes: this.#capBytes });
  }
}
