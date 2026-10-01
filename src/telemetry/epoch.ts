import { isWide, type Value } from '@/core/variables';

import type { Block, BlockLayout } from './block';
import type { PersistedBlock } from './persistence';
import { LEAF_SIZE } from './pyramid';
import { type ColumnKind, columnKindOf, kindOfColumn, toNumber } from './storage';
import type { RecordedEpoch, RecordedGap, HistoryVariable } from './types';

/**
 * How many samples the first block of an epoch holds. Each block that fills makes the next one
 * twice as large, up to the store's block size, so that short epochs take little memory; a block
 * sealed before it filled leaves the size as it is.
 */
export const FIRST_BLOCK_SIZE = 1024;

/** What one gap record is counted as against the memory cap. */
export const GAP_BYTES = 64;

/** {@link Epoch.receive}: the sample's time is before the previous one's. */
export const RECEIVED_BACKWARDS = -2;

/** {@link Epoch.receive}: the sample has the previous one's time, so it is the same sample. */
export const RECEIVED_DUPLICATE = -1;

/**
 * Samples missing inside an epoch, before the sample stored at {@link EpochGap.index}.
 */
export interface EpochGap {
  /** Whether they never arrived or were not kept. */
  readonly kind: 'dropped' | 'not-stored';

  /** The epoch sample index of the first stored sample after the gap. */
  index: number;

  /** How many samples are missing. */
  count: number;

  /** Where the gap starts: the last sample before it, or the first sample not kept. */
  readonly startUs: number;

  /** The time of the last sample kept before the gap, or NaN if there is none. */
  readonly afterUs: number;

  /** The time of the first sample kept after the gap, or NaN until it arrives. */
  untilUs: number;
}

/**
 * What an epoch needs from the store around it.
 */
export interface EpochHost {
  /** A new block, or undefined if the memory cap does not allow one. */
  allocate(layout: BlockLayout): Block | undefined;

  /** A block will take no more samples. */
  seal(block: Block): void;

  /** A gap will not change any more. */
  gapFinal(epoch: Epoch, gap: EpochGap): void;

  /** Memory outside the blocks was taken, or given back when negative. */
  account(bytes: number): void;
}

/**
 * The samples of one definition of a stream group.
 *
 * The source tells how many samples it lost before each one that arrives, which makes a gap of
 * dropped samples, different from the time outside any epoch, when the variable was not streamed
 * at all. Time never goes back inside an epoch, so a sample is a duplicate when its time repeats.
 */
export class Epoch {
  /** The session's id for the epoch. */
  readonly id: number;

  /** The robot's group slot. */
  readonly groupId: number;

  /** The variables of each sample, in wire order, with their names. */
  readonly variables: readonly HistoryVariable[];

  /** For each variable, its column among the numeric ones, or -1 for a blob. */
  readonly columnOf: readonly number[];

  /** For each variable, whether its values may lose precision as floats. */
  readonly wide: readonly boolean[];

  /** The blocks in memory or in the persistence layer, oldest first. */
  readonly blocks: Block[] = [];

  /** Dropped and unstored samples, in sample order. */
  readonly gaps: EpochGap[] = [];

  /** The time of the first sample ever stored, or NaN. */
  firstStoredUs = Number.NaN;

  /** The time of the last stored sample, or NaN. */
  lastTimeUs = Number.NaN;

  /** How many samples were stored. */
  storedCount = 0;

  /** How many stored samples the memory cap later made the store let go of. */
  trimmedCount = 0;

  /** How many samples the source lost. */
  droppedCount = 0;

  private readonly numericIds: readonly number[];
  private readonly kinds: readonly ColumnKind[];
  private readonly row: Float64Array;
  private readonly pending: EpochGap[] = [];
  private capacity: number;
  private nextBlockIndex = 0;
  private pendingUnstored = 0;
  private unstoredFromUs = Number.NaN;
  private lastSeenUs = Number.NEGATIVE_INFINITY;
  private isClosed = false;

  /**
   * @param spec The group layout, with names.
   * @param blockSize How many samples a block holds at most.
   * @param host Where blocks come from and where changes go.
   */
  constructor(
    spec: RecordedEpoch,
    private readonly blockSize: number,
    private readonly host: EpochHost
  ) {
    this.id = spec.epochId;
    this.groupId = spec.groupId;
    this.variables = [...spec.variables];
    this.capacity = Math.min(blockSize, FIRST_BLOCK_SIZE);

    const numericIds: number[] = [];
    const kinds: ColumnKind[] = [];
    const columnOf: number[] = [];

    for (const variable of this.variables) {
      const kind = columnKindOf(variable.type);
      columnOf.push(kind ? numericIds.length : -1);

      if (kind) {
        numericIds.push(variable.id);
        kinds.push(kind);
      }
    }

    this.numericIds = numericIds;
    this.kinds = kinds;
    this.columnOf = columnOf;
    this.wide = this.variables.map((variable) => isWide(variable.type));
    this.row = new Float64Array(numericIds.length);
  }

  /** Whether the epoch takes no more samples. */
  get closed(): boolean {
    return this.isClosed;
  }

  /** The time of the first sample still kept, or NaN. */
  get firstTimeUs(): number {
    return this.blocks.find((block) => block.length > 0)?.firstTimeUs ?? Number.NaN;
  }

  /** How many samples are kept. */
  get keptCount(): number {
    return this.storedCount - this.trimmedCount;
  }

  /** How many samples arrived since the last stored one without being kept. */
  get unstoredRun(): number {
    return this.pendingUnstored;
  }

  /** The time of the first sample of the current unstored run, or NaN. */
  get unstoredFrom(): number {
    return this.unstoredFromUs;
  }

  /** The epoch as a recording remembers it. */
  get recorded(): RecordedEpoch {
    return { epochId: this.id, groupId: this.groupId, variables: this.variables };
  }

  /**
   * Account for an arriving sample before it is stored: its time and the samples the source lost
   * just before it. A sample the memory cap then keeps out of the history still counts as arrived.
   * A duplicate or a sample from the past is left out, and so is the loss it reports.
   *
   * @param timeUs When it was taken.
   * @param missedBefore How many samples the source lost just before it.
   * @returns How many samples before it never arrived, or {@link RECEIVED_DUPLICATE} or
   *   {@link RECEIVED_BACKWARDS} for a sample to leave out of the history.
   */
  receive(timeUs: number, missedBefore: number): number {
    if (timeUs <= this.lastSeenUs) {
      return timeUs < this.lastSeenUs ? RECEIVED_BACKWARDS : RECEIVED_DUPLICATE;
    }

    this.lastSeenUs = timeUs;

    if (missedBefore > 0) {
      this.droppedCount += missedBefore;
      this.addGap('dropped', missedBefore, this.lastTimeUs, true);
    }

    return missedBefore;
  }

  /**
   * Store a sample, if the memory cap allows.
   *
   * @param timeUs When it was taken.
   * @param values Its values, in wire order.
   * @returns Whether it was stored.
   */
  store(timeUs: number, values: ArrayLike<Value>): boolean {
    const block = this.writableBlock();

    if (!block) {
      if (this.pendingUnstored === 0) {
        this.unstoredFromUs = timeUs;
      }

      this.pendingUnstored++;
      return false;
    }

    this.endUnstoredRun(timeUs);

    for (let variable = 0; variable < this.columnOf.length; variable++) {
      const column = this.columnOf[variable];

      if (column >= 0) {
        this.row[column] = toNumber(values[variable]);
      }
    }

    block.append(timeUs, this.row);

    if (this.storedCount === 0) {
      this.firstStoredUs = timeUs;
    }

    this.storedCount++;
    this.lastTimeUs = timeUs;
    this.resolvePending(timeUs);

    if (block.full) {
      this.capacity = Math.min(this.blockSize, this.capacity * 2);
      this.host.seal(block);
    }

    return true;
  }

  /**
   * Seal the block being filled, if it holds anything, so that it can be written away now. The
   * next sample starts a new block.
   */
  sealOpenBlock(): void {
    const last = this.blocks.at(-1);

    if (last && !last.sealed && last.length > 0) {
      this.host.seal(last);
    }
  }

  /**
   * Take no more samples: seal the last block, and make the gaps still open final.
   */
  close(): void {
    if (this.isClosed) {
      return;
    }

    this.isClosed = true;
    this.sealOpenBlock();
    this.endUnstoredRun(Number.NaN);
    this.resolvePending(Number.NaN);
  }

  /**
   * Let go of a sealed block to make room, keeping the stretch it covered as a gap of samples not
   * stored.
   */
  dropBlock(block: Block): void {
    const position = this.blocks.indexOf(block);

    if (position < 0) {
      return;
    }

    this.blocks.splice(position, 1);
    this.trimmedCount += block.length;
    const start = block.startSample;
    const end = start + block.length;
    const inside = this.gaps.filter((gap) => gap.index > start && gap.index < end);

    for (const gap of inside) {
      this.gaps.splice(this.gaps.indexOf(gap), 1);
      this.host.account(-GAP_BYTES);
    }

    const next = this.blocks[position];
    const previous = this.gaps.find((gap) => gap.kind === 'not-stored' && gap.index === start);

    const gap: EpochGap = previous ?? {
      kind: 'not-stored',
      index: end,
      count: 0,
      startUs: block.firstTimeUs,
      afterUs: this.blocks[position - 1]?.lastTimeUs ?? Number.NaN,
      untilUs: Number.NaN,
    };
    gap.index = end;
    gap.count += block.length;
    gap.untilUs = next?.firstTimeUs ?? Number.NaN;

    if (!previous) {
      const after = this.gaps.findIndex((other) => other.index > end);
      this.gaps.splice(after < 0 ? this.gaps.length : after, 0, gap);
      this.host.account(GAP_BYTES);
    }

    if (!next && !this.isClosed && !this.pending.includes(gap)) {
      this.pending.push(gap);
    }
  }

  /**
   * Forget every sample and gap, so that an open epoch carries on from nothing.
   */
  clearHistory(): void {
    this.host.account(-GAP_BYTES * this.gaps.length);
    this.blocks.length = 0;
    this.gaps.length = 0;
    this.pending.length = 0;
    this.firstStoredUs = Number.NaN;
    this.lastTimeUs = Number.NaN;
    this.storedCount = 0;
    this.trimmedCount = 0;
    this.droppedCount = 0;
    this.pendingUnstored = 0;
    this.unstoredFromUs = Number.NaN;
    this.capacity = Math.min(this.blockSize, FIRST_BLOCK_SIZE);
  }

  /** A gap as a recording remembers it. */
  recordedGap(gap: EpochGap): RecordedGap {
    return { epochId: this.id, ...gap };
  }

  /**
   * Take back a sealed block of a recording, after the ones taken back before it: the reader
   * gives an epoch's blocks in index order, whatever order the file has them in.
   *
   * @returns The block, or undefined if the memory cap left no room for it.
   * @throws If the block's columns are not the epoch's, or its index is not past the last one.
   */
  restoreBlock(persisted: PersistedBlock): Block | undefined {
    const length = persisted.time.length;
    const matches =
      persisted.columns.length === this.numericIds.length &&
      persisted.columns.every(
        (column, index) =>
          column.variableId === this.numericIds[index] &&
          kindOfColumn(column.values) === this.kinds[index] &&
          column.values.length === length
      );

    if (!matches) {
      throw new Error(`Block ${persisted.ref.index} does not fit the columns of epoch ${this.id}`);
    }

    const last = this.blocks.at(-1);

    if (last !== undefined && last.ref.index >= persisted.ref.index) {
      throw new Error(
        `Block ${persisted.ref.index} of epoch ${this.id} comes after block ${last.ref.index}`
      );
    }

    const block = this.host.allocate({
      ref: persisted.ref,
      startSample: persisted.startSample,
      capacity: Math.max(LEAF_SIZE, 2 ** Math.ceil(Math.log2(Math.max(1, length)))),
      variableIds: this.numericIds,
      kinds: this.kinds,
    });

    if (!block) {
      return undefined;
    }

    for (let sample = 0; sample < length; sample++) {
      for (let column = 0; column < this.row.length; column++) {
        this.row[column] = persisted.columns[column].values[sample];
      }

      block.append(persisted.time[sample], this.row);
    }

    this.host.seal(block);
    this.blocks.push(block);
    this.storedCount = Math.max(this.storedCount, persisted.startSample + length);
    this.nextBlockIndex = Math.max(this.nextBlockIndex, persisted.ref.index + 1);
    return block;
  }

  /**
   * Take back a gap of a recording. A gap with the start of one taken before replaces it, since
   * a recorder writes a gap again when it grows.
   */
  restoreGap(recorded: RecordedGap): void {
    const gap: EpochGap = {
      kind: recorded.kind,
      index: recorded.index,
      count: recorded.count,
      startUs: recorded.startUs,
      afterUs: recorded.afterUs,
      untilUs: recorded.untilUs,
    };
    const same = this.gaps.findIndex(
      (other) =>
        other.startUs === gap.startUs || (Number.isNaN(other.startUs) && Number.isNaN(gap.startUs))
    );

    if (same >= 0) {
      this.gaps.splice(same, 1);
    } else {
      this.host.account(GAP_BYTES);
    }

    const after = this.gaps.findIndex((other) => other.index > gap.index);
    this.gaps.splice(after < 0 ? this.gaps.length : after, 0, gap);
  }

  /**
   * End a restore: the epoch takes no more samples, and its counts follow from the blocks and
   * gaps taken back.
   */
  finishRestore(): void {
    this.isClosed = true;
    let kept = 0;

    for (const block of this.blocks) {
      kept += block.length;
    }

    this.droppedCount = 0;
    let firstUs = this.blocks[0]?.firstTimeUs ?? Number.NaN;

    for (const gap of this.gaps) {
      if (gap.kind === 'dropped') {
        this.droppedCount += gap.count;
      } else {
        this.storedCount = Math.max(this.storedCount, gap.index);

        if (!(gap.startUs >= firstUs)) {
          firstUs = Number.isNaN(gap.startUs) ? firstUs : gap.startUs;
        }
      }
    }

    this.trimmedCount = this.storedCount - kept;
    this.firstStoredUs = firstUs;
    this.lastTimeUs = this.blocks.at(-1)?.lastTimeUs ?? Number.NaN;
    this.lastSeenUs = Number.isNaN(this.lastTimeUs) ? this.lastSeenUs : this.lastTimeUs;
  }

  private writableBlock(): Block | undefined {
    const last = this.blocks.at(-1);

    if (last && !last.sealed) {
      return last;
    }

    const block = this.host.allocate({
      ref: { epochId: this.id, index: this.nextBlockIndex },
      startSample: this.storedCount,
      capacity: this.capacity,
      variableIds: this.numericIds,
      kinds: this.kinds,
    });

    if (block) {
      this.nextBlockIndex++;
      this.blocks.push(block);
    }

    return block;
  }

  private endUnstoredRun(untilUs: number): void {
    if (this.pendingUnstored === 0) {
      return;
    }

    const gap = this.addGap('not-stored', this.pendingUnstored, this.unstoredFromUs, false);
    gap.untilUs = untilUs;
    this.pendingUnstored = 0;
    this.unstoredFromUs = Number.NaN;

    if (!this.pending.includes(gap)) {
      this.host.gapFinal(this, gap);
    }
  }

  private resolvePending(untilUs: number): void {
    for (const gap of this.pending) {
      gap.untilUs = untilUs;
      this.host.gapFinal(this, gap);
    }

    this.pending.length = 0;
  }

  private addGap(
    kind: EpochGap['kind'],
    count: number,
    startUs: number,
    pending: boolean
  ): EpochGap {
    const last = this.gaps.at(-1);

    if (
      last &&
      last.kind === kind &&
      last.index === this.storedCount &&
      this.pending.includes(last)
    ) {
      last.count += count;
      return last;
    }

    const gap: EpochGap = {
      kind,
      index: this.storedCount,
      count,
      startUs,
      afterUs: this.lastTimeUs,
      untilUs: Number.NaN,
    };
    this.gaps.push(gap);
    this.host.account(GAP_BYTES);

    if (pending) {
      this.pending.push(gap);
    }

    return gap;
  }
}
