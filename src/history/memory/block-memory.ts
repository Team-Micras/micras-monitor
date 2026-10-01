import { Block, type BlockLayout } from '../block';
import type { BlockPersistence, PersistedBlock } from '../block-backing';
import type { BlockAccess } from '../decimation';
import type { Scheduler } from '../scheduler';
import type { StoreStatus, TelemetryEvent } from '../types';

const FIRST_BACKOFF_MS = 1000;
const LAST_BACKOFF_MS = 60_000;

/**
 * What the residency needs from the store around it.
 */
export interface ResidencyOptions {
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

  /** Tell the user about something. */
  readonly emit: (event: TelemetryEvent) => void;

  /** Something in {@link BlockResidency.status} changed. */
  readonly statusChanged: () => void;

  /** Seal the block every open epoch is filling. */
  readonly sealOpenBlocks: () => void;

  /** An evicted block is back in memory. */
  readonly reloaded: (block: Block) => void;

  /** A block's raw samples left memory; a copy remains. */
  readonly evicted: (block: Block) => void;

  /** A block was let go of for good. */
  readonly dropped: (block: Block) => void;
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
export class BlockResidency implements BlockAccess {
  private blocks: Block[] = [];
  private usedBytes = 0;
  private fixedBytes = 0;
  private pendingWrites = 0;
  private readonly writes = new Set<Promise<void>>();
  private recording: BlockPersistence | undefined;
  private historyStopped = false;
  private roomChanged = false;
  private warned = false;
  private failing = false;
  private backoffMs = FIRST_BACKOFF_MS;
  private retryAtMs = 0;
  private lastFlushMs = 0;
  private tick = 1;
  private tickScheduled = false;
  private readonly requests = new Set<Block>();
  private activeLoads = 0;
  private generation = 0;

  /**
   * @param options The cap, the clock and how to report.
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
      persistenceFailing: this.failing,
      residentBlocks,
      evictedBlocks: this.blocks.length - residentBlocks,
    };
  }

  /**
   * A new block, or undefined if the memory cap does not allow one. While stopped, it only tries
   * again once something freed memory, and asks for room for two blocks before resuming.
   */
  allocate(layout: BlockLayout): Block | undefined {
    if (this.historyStopped && !this.roomChanged) {
      return undefined;
    }

    this.roomChanged = false;
    const bytes = Block.byteLengthFor(layout);
    const fits = this.makeRoom(this.historyStopped ? 2 * bytes : bytes, false);
    const overdraft = this.pendingWrites > 0 && this.usedBytes <= this.options.capBytes;

    if (!fits && !overdraft) {
      this.stopHistory();
      return undefined;
    }

    const block = new Block(layout);
    this.blocks.push(block);
    this.usedBytes += bytes;
    this.fixedBytes += block.indexByteLength;

    if (this.historyStopped) {
      this.historyStopped = false;
      this.options.emit({ type: 'history-resumed' });
    }

    this.checkWarning();
    this.options.statusChanged();
    return block;
  }

  /** A block takes no more samples: compact it if it did not fill, and write it if recording. */
  seal(block: Block): void {
    block.seal();
    const indexBefore = block.indexByteLength;
    this.usedBytes -= block.compact();
    this.fixedBytes += block.indexByteLength - indexBefore;
    this.persistSealed();
  }

  /**
   * A block restored from a recording already has a copy there: it can leave memory at once, and
   * comes back from the recording when a query needs it.
   */
  adopt(block: Block, source: BlockPersistence): void {
    block.copy = source;
    block.recordedBy = source;
    this.roomChanged = true;
    this.makeRoom(0, false);
  }

  /** Memory outside the blocks was taken, or given back when negative. */
  account(bytes: number): void {
    this.usedBytes += bytes;
    this.fixedBytes += bytes;
    this.checkWarning();
    this.options.statusChanged();
  }

  /**
   * Called for every sample: while recording, seal and write the blocks being filled once the
   * flush interval has passed, and retry failed writes once their backoff has.
   */
  flushIfDue(): void {
    if (!this.recording) {
      return;
    }

    const now = this.options.now();

    if (now - this.lastFlushMs >= this.options.flushIntervalMs) {
      this.lastFlushMs = now;
      this.options.sealOpenBlocks();
      this.persistSealed();
    }
  }

  /**
   * Start writing blocks to a persistence layer: first the whole session so far, the blocks
   * being filled sealed and those evicted read back from where they live, then every block as
   * it seals.
   */
  startRecording(persistence: BlockPersistence): void {
    this.recording = persistence;
    this.failing = false;
    this.backoffMs = FIRST_BACKOFF_MS;
    this.retryAtMs = 0;
    this.lastFlushMs = this.options.now();
    this.warned = false;
    this.options.sealOpenBlocks();
    this.persistSealed();
    void this.backfill(persistence);
    this.checkWarning();
    this.options.statusChanged();
  }

  /**
   * Seal and write what is being filled, then stop writing blocks. Blocks already written can
   * still leave memory and come back.
   *
   * @returns A promise that settles once every write under way has.
   */
  stopRecording(): Promise<void> {
    this.options.sealOpenBlocks();
    this.retryAtMs = 0;
    this.persistSealed();
    this.recording = undefined;
    this.warned = false;
    this.checkWarning();
    this.options.statusChanged();
    return Promise.all(this.writes).then(() => undefined);
  }

  /** Forget every block and stop recording, as for a new session. */
  reset(): void {
    this.generation++;
    this.blocks = [];
    this.usedBytes = 0;
    this.fixedBytes = 0;
    this.pendingWrites = 0;
    this.writes.clear();
    this.recording = undefined;
    this.historyStopped = false;
    this.roomChanged = true;
    this.warned = false;
    this.failing = false;
    this.requests.clear();
    this.activeLoads = 0;
    this.options.statusChanged();
  }

  /** Start a query: its blocks count as used in the current tick. */
  beginQuery(): void {
    if (this.tickScheduled) {
      return;
    }

    this.tickScheduled = true;
    this.options.scheduler.schedule(() => this.endTick());
  }

  /** {@inheritDoc BlockAccess.markUsed} */
  markUsed(block: Block): void {
    block.lastUsed = this.tick;
  }

  /** {@inheritDoc BlockAccess.request} */
  request(block: Block): void {
    if (!block.resident && !block.loading && block.copy) {
      this.requests.add(block);
    }
  }

  private endTick(): void {
    for (const block of this.requests) {
      if (this.activeLoads >= this.options.maxConcurrentLoads) {
        break;
      }

      this.startLoad(block);
    }

    this.requests.clear();
    this.tickScheduled = false;
    this.tick++;
  }

  private startLoad(block: Block): void {
    const source = block.copy;

    if (!source || block.resident || block.loading) {
      return;
    }

    const reserved = block.restoredByteLength;

    if (!this.makeRoom(reserved, true)) {
      return;
    }

    this.usedBytes += reserved;
    block.loading = true;
    this.activeLoads++;
    void this.load(block, source, reserved);
  }

  private async load(block: Block, source: BlockPersistence, reserved: number): Promise<void> {
    const generation = this.generation;
    let restored = false;

    try {
      const persisted = await source.read(block.ref);

      if (generation === this.generation && !block.resident) {
        this.usedBytes += block.restore(persisted) - reserved;
        block.lastUsed = this.tick;
        restored = true;
      }
    } catch (error) {
      this.options.emit({ type: 'persistence-error', error });
    } finally {
      block.loading = false;

      if (generation === this.generation) {
        this.activeLoads--;

        if (!restored) {
          this.usedBytes -= reserved;
          this.roomChanged = true;
        }

        this.options.statusChanged();
      }
    }

    if (restored) {
      this.options.reloaded(block);
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

  private makeRoom(bytes: number, forLoad: boolean): boolean {
    if (forLoad && this.usedBytes - this.evictableBytes() + bytes > this.options.capBytes) {
      return false;
    }

    let changed = false;

    while (this.usedBytes + bytes > this.options.capBytes) {
      const victim = this.evictable(forLoad);

      if (victim) {
        this.usedBytes -= victim.evict();
        this.options.evicted(victim);
        changed = true;
        continue;
      }

      const oldest = forLoad || this.recording ? undefined : this.droppable();

      if (!oldest) {
        break;
      }

      this.drop(oldest);
      changed = true;
    }

    if (changed) {
      this.roomChanged = true;
      this.options.statusChanged();
    }

    return this.usedBytes + bytes <= this.options.capBytes;
  }

  private evictable(forLoad: boolean): Block | undefined {
    let victim: Block | undefined;

    for (const block of this.blocks) {
      if (this.canEvict(block, forLoad) && (!victim || block.lastUsed < victim.lastUsed)) {
        victim = block;
      }
    }

    return victim;
  }

  private evictableBytes(): number {
    let bytes = 0;

    for (const block of this.blocks) {
      if (this.canEvict(block, true)) {
        bytes += block.rawByteLength;
      }
    }

    return bytes;
  }

  private canEvict(block: Block, forLoad: boolean): boolean {
    return (
      block.resident &&
      block.copy !== undefined &&
      !block.writing &&
      !block.loading &&
      !(forLoad && block.lastUsed === this.tick)
    );
  }

  private droppable(): Block | undefined {
    return this.blocks.find(
      (block) => block.sealed && block.resident && !block.copy && !block.writing
    );
  }

  private drop(block: Block): void {
    this.blocks.splice(this.blocks.indexOf(block), 1);
    this.usedBytes -= block.rawByteLength + block.indexByteLength;
    this.fixedBytes -= block.indexByteLength;
    this.options.dropped(block);
    this.options.emit({
      type: 'history-dropped',
      untilUs: block.lastTimeUs,
      usedBytes: this.usedBytes,
      capBytes: this.options.capBytes,
    });
  }

  private checkWarning(): void {
    const pressure = this.recording ? this.fixedBytes : this.usedBytes;

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

    if (!target || (this.failing && this.options.now() < this.retryAtMs)) {
      return;
    }

    for (const block of this.blocks) {
      if (block.sealed && block.resident && block.recordedBy !== target && !block.writing) {
        this.track(this.persist(block, target, () => Promise.resolve(block.toPersisted())));
      }
    }
  }

  private async backfill(target: BlockPersistence): Promise<void> {
    const evicted = this.blocks.filter((block) => !block.resident && block.recordedBy !== target);

    await evicted.reduce<Promise<void>>(async (previous, block) => {
      await previous;
      const source = block.copy;

      if (this.recording !== target || !source || block.resident || block.writing) {
        return;
      }

      const write = this.persist(block, target, () => source.read(block.ref));
      this.track(write);
      await write;
    }, Promise.resolve());
  }

  private track(write: Promise<void>): void {
    this.writes.add(write);
    void write.finally(() => this.writes.delete(write));
  }

  private async persist(
    block: Block,
    target: BlockPersistence,
    contents: () => Promise<PersistedBlock>
  ): Promise<void> {
    const generation = this.generation;
    block.writing = true;
    this.pendingWrites++;

    try {
      await target.write(await contents());
      block.copy = target;
      block.recordedBy = target;
      block.writeFailed = false;
      this.recovered();
    } catch (error) {
      block.writeFailed = true;
      this.failed(error);
    } finally {
      block.writing = false;

      if (generation === this.generation) {
        this.pendingWrites--;
        this.roomChanged = true;
      }
    }

    if (generation === this.generation) {
      this.makeRoom(0, false);
    }
  }

  private failed(error: unknown): void {
    const now = this.options.now();

    if (now >= this.retryAtMs) {
      this.retryAtMs = now + this.backoffMs;
      this.backoffMs = Math.min(LAST_BACKOFF_MS, 2 * this.backoffMs);
    }

    if (!this.failing) {
      this.failing = true;
      this.options.emit({ type: 'persistence-error', error });
      this.options.statusChanged();
    }
  }

  private recovered(): void {
    this.backoffMs = FIRST_BACKOFF_MS;

    if (this.failing) {
      this.failing = false;
      this.options.emit({ type: 'persistence-recovered' });
      this.options.statusChanged();
    }
  }
}
