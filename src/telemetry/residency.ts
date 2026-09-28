import { Block, type BlockLayout } from './block';
import type { BlockAccess } from './decimation';
import type { BlockSource } from './epoch';
import type { BlockPersistence } from './persistence';
import type { StoreStatus, TelemetryEvent } from './types';

/**
 * What the residency needs from the store around it.
 */
export interface ResidencyOptions {
  /** The most memory blocks may take. */
  readonly capBytes: number;

  /** The share of the cap at which to warn. */
  readonly warningRatio: number;

  /** Tell the user about something. */
  readonly emit: (event: TelemetryEvent) => void;

  /** Something in {@link BlockResidency.status} changed. */
  readonly statusChanged: () => void;

  /** An evicted block is back in memory. */
  readonly reloaded: (block: Block) => void;
}

/**
 * Decides which blocks hold their samples in memory, under a memory cap.
 *
 * While recording, every sealed block is written to the persistence layer. A block with a
 * persisted copy can leave memory when room is needed, least recently read first, and comes back
 * when a query needs its raw samples. While a write is under way the blocks may go one block over
 * the cap, so that the samples arriving just after a block fills are not lost to the write's
 * latency. When nothing can leave, new samples stop being kept, and the latest values carry on
 * without them.
 *
 * The warning comes at a share of the cap: of all the memory while not recording, and of the
 * memory nothing can free, the pyramids and leaf times, while recording.
 */
export class BlockResidency implements BlockSource, BlockAccess {
  private readonly blocks: Block[] = [];
  private usedBytes = 0;
  private indexBytes = 0;
  private pendingWrites = 0;
  private recording: BlockPersistence | undefined;
  private historyStopped = false;
  private warned = false;
  private tick = 0;

  /**
   * @param options The cap and how to report on it.
   */
  constructor(private readonly options: ResidencyOptions) {}

  /** The memory the blocks take and what is recording, for the status snapshot. */
  status(): StoreStatus {
    let residentBlocks = 0;

    for (const block of this.blocks) {
      if (block.resident) {
        residentBlocks++;
      }
    }

    return {
      usedBytes: this.usedBytes,
      capBytes: this.options.capBytes,
      historyStopped: this.historyStopped,
      recording: this.recording !== undefined,
      residentBlocks,
      evictedBlocks: this.blocks.length - residentBlocks,
    };
  }

  /** {@inheritDoc BlockSource.allocate} */
  allocate(layout: BlockLayout): Block | undefined {
    const bytes = Block.byteLengthFor(layout);
    const fits = this.makeRoom(bytes);
    const overdraft = this.pendingWrites > 0 && this.usedBytes <= this.options.capBytes;

    if (!fits && !overdraft) {
      this.stopHistory();
      return undefined;
    }

    const block = new Block(layout);
    this.blocks.push(block);
    this.usedBytes += bytes;
    this.indexBytes += block.indexByteLength;

    if (this.historyStopped) {
      this.historyStopped = false;
      this.options.emit({ type: 'history-resumed' });
    }

    this.checkWarning();
    this.options.statusChanged();
    return block;
  }

  /** {@inheritDoc BlockSource.seal} */
  seal(block: Block): void {
    block.seal();
    this.persistSealed();
  }

  /**
   * Start writing sealed blocks, the ones already sealed included, to a persistence layer.
   */
  startRecording(persistence: BlockPersistence): void {
    this.recording = persistence;
    this.warned = false;
    this.persistSealed();
    this.checkWarning();
    this.options.statusChanged();
  }

  /**
   * Stop writing blocks. Those already written can still leave memory and come back.
   */
  stopRecording(): void {
    this.recording = undefined;
    this.warned = false;
    this.checkWarning();
    this.options.statusChanged();
  }

  /**
   * Start a query, so that the blocks it reads count as the most recently used.
   */
  beginQuery(): void {
    this.tick++;
  }

  /** {@inheritDoc BlockAccess.touch} */
  touch(block: Block): boolean {
    block.lastUsed = this.tick;
    return block.resident;
  }

  /** {@inheritDoc BlockAccess.request} */
  request(block: Block): void {
    if (!block.resident) {
      void this.load(block);
    }
  }

  private stopHistory(): void {
    if (this.historyStopped) {
      return;
    }

    this.historyStopped = true;
    this.options.emit({
      type: 'history-stopped',
      usedBytes: this.usedBytes,
      capBytes: this.options.capBytes,
    });
    this.options.statusChanged();
  }

  private makeRoom(bytes: number, keep?: Block): boolean {
    let evicted = false;

    while (this.usedBytes + bytes > this.options.capBytes) {
      const victim = this.leastRecentlyUsed(keep);

      if (!victim) {
        break;
      }

      this.usedBytes -= victim.evict();
      evicted = true;
    }

    if (evicted) {
      this.options.statusChanged();
    }

    return this.usedBytes + bytes <= this.options.capBytes;
  }

  private leastRecentlyUsed(keep: Block | undefined): Block | undefined {
    let victim: Block | undefined;

    for (const block of this.blocks) {
      if (block === keep || !block.resident || !block.persistedTo || block.loading) {
        continue;
      }

      if (!victim || block.lastUsed < victim.lastUsed) {
        victim = block;
      }
    }

    return victim;
  }

  private checkWarning(): void {
    const pressure = this.recording ? this.indexBytes : this.usedBytes;

    if (pressure < this.options.capBytes * this.options.warningRatio) {
      this.warned = false;
      return;
    }

    if (this.warned) {
      return;
    }

    this.warned = true;
    this.options.emit({
      type: 'memory-warning',
      usedBytes: this.usedBytes,
      capBytes: this.options.capBytes,
    });
  }

  private persistSealed(): void {
    const target = this.recording;

    if (!target) {
      return;
    }

    for (const block of this.blocks) {
      if (block.sealed && block.resident && !block.persistedTo && !block.writing) {
        void this.persist(block, target);
      }
    }
  }

  private async persist(block: Block, target: BlockPersistence): Promise<void> {
    block.writing = true;
    this.pendingWrites++;

    try {
      await target.write(block.toPersisted());
      block.persistedTo = target;
    } catch (error) {
      this.options.emit({ type: 'persistence-error', error });
    } finally {
      block.writing = false;
      this.pendingWrites--;
    }

    this.makeRoom(0);
  }

  private async load(block: Block): Promise<void> {
    const source = block.persistedTo;

    if (!source || block.loading || !this.makeRoom(block.restoredByteLength, block)) {
      return;
    }

    block.loading = true;

    try {
      const persisted = await source.read(block.ref);

      if (block.resident || !this.makeRoom(block.restoredByteLength, block)) {
        return;
      }

      this.usedBytes += block.restore(persisted);
      block.lastUsed = this.tick;
      this.options.reloaded(block);
      this.options.statusChanged();
    } catch (error) {
      this.options.emit({ type: 'persistence-error', error });
    } finally {
      block.loading = false;
    }
  }
}
