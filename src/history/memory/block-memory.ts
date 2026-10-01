import type { Emitter } from '@/core/emitter';

import { Block, type BlockLayout } from '../block';
import type { BlockBacking } from '../block-backing';
import type { Scheduler } from '../scheduler';
import type { StreamRun } from '../stream-run';
import type { ChangeSignal } from '../tick-notifier';
import type { StoreStatus, StoreWarning } from '../types';
import { BlockLoader } from './block-loader';
import { BlockWriter } from './block-writer';

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

  /** The store's runs by id, told when one of their blocks leaves memory, returns or is let go of. */
  readonly runs: ReadonlyMap<number, StreamRun>;

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
 *   dies; {@link writer} does the writing. A block with a copy can leave memory when room is
 *   needed, least recently read first, and comes back through {@link loader} when a query needs
 *   its raw samples. While a write is under way the blocks may go one block over the cap, rather
 *   than lose samples to the write's latency. If nothing can leave, new samples stop being kept
 *   until room comes back.
 * - While not recording, the live view never stops: at the cap, the oldest sealed blocks without
 *   a copy are let go of, and their stretch becomes a gap of samples not stored.
 *
 * The warning comes at a share of the cap: of all the memory while not recording, and of the
 * memory nothing can free, the pyramids, leaf times and gap records, while recording.
 */
export class BlockMemory {
  /** Reads evicted blocks back for the queries. */
  readonly loader: BlockLoader;

  /** Writes sealed blocks to the persistence layer while recording. */
  readonly writer: BlockWriter;

  readonly #capBytes: number;
  readonly #warningRatio: number;
  readonly #runs: ReadonlyMap<number, StreamRun>;
  readonly #warnings: Emitter<{ warning: StoreWarning }>;
  readonly #statusSignal: ChangeSignal;
  #blocks: Block[] = [];
  #usedBytes = 0;
  #fixedBytes = 0;
  #historyStopped = false;
  #roomChanged = false;
  #warned = false;
  #resetCount = 0;
  #status: StoreStatus;

  /**
   * @param options The cap, the clock, the runs and where to report.
   */
  constructor(options: BlockMemoryOptions) {
    this.#capBytes = options.capBytes;
    this.#warningRatio = options.warningRatio;
    this.#runs = options.runs;
    this.#warnings = options.warnings;
    this.#statusSignal = options.statusSignal;
    this.loader = new BlockLoader(this, options.scheduler, options.maxConcurrentLoads);
    this.writer = new BlockWriter(this, options.now, options.flushIntervalMs);
    this.#status = this.#snapshot();
  }

  /** Every block, oldest first. */
  get blocks(): readonly Block[] {
    return this.#blocks;
  }

  /** How many times {@link reset} forgot every block, so that work started before can tell. */
  get resetCount(): number {
    return this.#resetCount;
  }

  /** The memory the blocks take and what is recording; the same object until it changes. */
  status(): StoreStatus {
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
    const fits = this.makeRoom(this.#historyStopped ? 2 * bytes : bytes, false);
    const overdraft = this.writer.pendingWrites > 0 && this.#usedBytes <= this.#capBytes;

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
      this.warn({ type: 'history-resumed' });
    }

    this.#checkWarning();
    this.statusChanged();
    return block;
  }

  /** A block takes no more samples: compact it if it did not fill, and write it if recording. */
  seal(block: Block): void {
    block.seal();
    const indexBefore = block.indexByteLength;
    this.#usedBytes -= block.compact();
    this.#fixedBytes += block.indexByteLength - indexBefore;
    this.writer.persistSealed();
  }

  /** Seal the block every open run is filling, in the order the runs opened. */
  sealOpenBlocks(): void {
    for (const run of this.#runs.values()) {
      if (!run.closed) {
        run.sealOpenBlock();
      }
    }
  }

  /**
   * A block restored from a recording already has a copy there: it can leave memory at once, and
   * comes back from the recording when a query needs it.
   */
  adopt(block: Block, source: BlockBacking): void {
    block.copy = source;
    this.#roomChanged = true;
    this.makeRoom(0, false);
  }

  /** Memory outside the blocks, which never leaves, was taken, or given back when negative. */
  account(bytes: number): void {
    this.#usedBytes += bytes;
    this.#fixedBytes += bytes;
    this.#checkWarning();
    this.statusChanged();
  }

  /** Raw samples were reserved, read back or given back, when negative. */
  charge(bytes: number): void {
    this.#usedBytes += bytes;
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
    this.loader.reset();
    this.writer.reset();
    this.statusChanged();
  }

  /**
   * Make room for some bytes: evict blocks with a copy, least recently used first, and, while
   * nothing records, let go of the oldest sealed blocks without one.
   *
   * @param bytes How many bytes are needed.
   * @param forLoad Whether a read needs them: it lets go of nothing, evicts no block used in the
   *   current query tick, and evicts nothing unless that makes enough room.
   * @returns Whether the bytes fit under the cap.
   */
  makeRoom(bytes: number, forLoad: boolean): boolean {
    if (forLoad && this.#usedBytes - this.#evictableBytes() + bytes > this.#capBytes) {
      return false;
    }

    let changed = false;

    while (this.#usedBytes + bytes > this.#capBytes) {
      const victim = this.#evictable(forLoad);

      if (victim) {
        this.#usedBytes -= victim.evict();
        this.ownerOf(victim)?.rewritten();
        changed = true;
        continue;
      }

      const oldest = forLoad || this.writer.recording ? undefined : this.#droppable();

      if (!oldest) {
        break;
      }

      this.#drop(oldest);
      changed = true;
    }

    if (changed) {
      this.#roomChanged = true;
      this.statusChanged();
    }

    return this.#usedBytes + bytes <= this.#capBytes;
  }

  /** Something may have freed memory, so that a stopped history tries to resume. */
  noteRoomChanged(): void {
    this.#roomChanged = true;
  }

  /** Warn again if the memory is past the share of the cap, as when recording starts or stops. */
  reconsiderWarning(): void {
    this.#warned = false;
    this.#checkWarning();
  }

  /** {@link status} changed. */
  statusChanged(): void {
    this.#status = this.#snapshot();
    this.#statusSignal.touch();
  }

  /** Tell the user about something. */
  warn(warning: StoreWarning): void {
    this.#warnings.emit('warning', warning);
  }

  /** The run a block belongs to, if the store still holds it. */
  ownerOf(block: Block): StreamRun | undefined {
    return this.#runs.get(block.ref.runId);
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
      recording: this.writer.recording,
      persistenceFailing: this.writer.failing,
      residentBlocks,
      evictedBlocks: this.#blocks.length - residentBlocks,
    };
  }

  #stopHistory(): void {
    if (this.#historyStopped) {
      return;
    }

    this.#historyStopped = true;
    this.warn({ type: 'history-stopped', usedBytes: this.#usedBytes, capBytes: this.#capBytes });
    this.statusChanged();
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
      !(forLoad && block.lastUsed === this.loader.tick)
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
    this.ownerOf(block)?.dropBlock(block);
    this.warn({
      type: 'history-dropped',
      untilUs: block.lastTimeUs,
      usedBytes: this.#usedBytes,
      capBytes: this.#capBytes,
    });
  }

  #checkWarning(): void {
    const pressure = this.writer.recording ? this.#fixedBytes : this.#usedBytes;

    if (pressure < this.#capBytes * this.#warningRatio) {
      this.#warned = false;
      return;
    }

    if (this.#warned) {
      return;
    }

    this.#warned = true;
    this.warn({ type: 'memory-warning', usedBytes: this.#usedBytes, capBytes: this.#capBytes });
  }
}
