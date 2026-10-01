import { isWide, type Value } from '@/core/variables';

import { fitsColumns, type Block } from './block';
import type { BlockData } from './block-backing';
import { type ColumnKind, columnKindOf, toNumber } from './columns';
import { GapLog } from './gap-log';
import type { BlockMemory } from './memory/block-memory';
import { LEAF_SIZE } from './min-max-pyramid';
import type { HistoryVariable, RecordedGap, RecordedRun, RunGap } from './types';
import type { VariableHistory } from './variable-history';

/**
 * How many samples the first block of a run holds. Each block that fills makes the next one
 * twice as large, up to the store's block size, so that short runs take little memory; a block
 * sealed before it filled leaves the size as it is.
 */
export const FIRST_BLOCK_SIZE = 1024;

/** {@link StreamRun.receive}: the sample's time is before the previous one's. */
export const RECEIVED_BACKWARDS = -2;

/** {@link StreamRun.receive}: the sample has the previous one's time, so it is the same sample. */
export const RECEIVED_DUPLICATE = -1;

/**
 * The samples of one run of a stream, from when it opened to when it ended.
 *
 * The source tells how many samples it lost before each one that arrives, which makes a gap of
 * dropped samples, different from the time outside any run, when the variable was not streamed
 * at all. Time never goes back inside a run, so a sample is a duplicate when its time repeats.
 * Its blocks come from the block memory, which tells the run when one of them leaves memory,
 * comes back or is let go of.
 */
export class StreamRun {
  /** The session's id for the run. */
  readonly id: number;

  /** Where the robot keeps the stream; a new stream in a slot replaces the one there. */
  readonly slot: number;

  /** The variables of each sample, in wire order, with their names. */
  readonly variables: readonly HistoryVariable[];

  /** The history of each variable, in wire order. */
  readonly records: readonly VariableHistory[];

  /** For each variable, its column among the numeric ones, or -1 for a blob. */
  readonly columnOf: readonly number[];

  /** For each variable, whether its values may lose precision as floats. */
  readonly wide: readonly boolean[];

  /** The blocks in memory or in the persistence layer, oldest first. */
  readonly blocks: Block[] = [];

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

  readonly #blockSize: number;
  readonly #memory: BlockMemory;
  readonly #gapLog: GapLog;
  readonly #numericIds: readonly number[];
  readonly #kinds: readonly ColumnKind[];
  readonly #row: Float64Array;
  #capacity: number;
  #nextBlockIndex = 0;
  #lastSeenUs = Number.NEGATIVE_INFINITY;
  #closed = false;

  /**
   * @param spec The stream's layout, with names.
   * @param records The history of each of its variables, in its order.
   * @param blockSize How many samples a block holds at most.
   * @param memory Where blocks come from.
   */
  constructor(
    spec: RecordedRun,
    records: readonly VariableHistory[],
    blockSize: number,
    memory: BlockMemory
  ) {
    this.id = spec.runId;
    this.slot = spec.slot;
    this.variables = [...spec.variables];
    this.records = records;
    this.#blockSize = blockSize;
    this.#memory = memory;
    this.#gapLog = new GapLog(memory);
    this.#capacity = Math.min(blockSize, FIRST_BLOCK_SIZE);

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

    this.#numericIds = numericIds;
    this.#kinds = kinds;
    this.columnOf = columnOf;
    this.wide = this.variables.map((variable) => isWide(variable.type));
    this.#row = new Float64Array(numericIds.length);
  }

  /** Whether the run takes no more samples. */
  get closed(): boolean {
    return this.#closed;
  }

  /** Dropped and unstored samples, in sample order. */
  get gaps(): readonly RunGap[] {
    return this.#gapLog.gaps;
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
    return this.#gapLog.unstoredRun;
  }

  /** The time of the first sample of the current unstored run, or NaN. */
  get unstoredFrom(): number {
    return this.#gapLog.unstoredFrom;
  }

  /** The run as a recording remembers it. */
  get recorded(): RecordedRun {
    return { runId: this.id, slot: this.slot, variables: this.variables };
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
    if (timeUs <= this.#lastSeenUs) {
      return timeUs < this.#lastSeenUs ? RECEIVED_BACKWARDS : RECEIVED_DUPLICATE;
    }

    this.#lastSeenUs = timeUs;

    if (missedBefore > 0) {
      this.droppedCount += missedBefore;
      this.#gapLog.addDropped(missedBefore, this.storedCount, this.lastTimeUs);
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
    const block = this.#writableBlock();

    if (!block) {
      this.#gapLog.noteUnstored(timeUs);
      return false;
    }

    this.#gapLog.endUnstoredRun(timeUs, this.storedCount, this.lastTimeUs);

    for (let variable = 0; variable < this.columnOf.length; variable++) {
      const column = this.columnOf[variable];

      if (column >= 0) {
        this.#row[column] = toNumber(values[variable]);
      }
    }

    block.append(timeUs, this.#row);

    if (this.storedCount === 0) {
      this.firstStoredUs = timeUs;
    }

    this.storedCount++;
    this.lastTimeUs = timeUs;
    this.#gapLog.resolvePending(timeUs);

    if (block.full) {
      this.#capacity = Math.min(this.#blockSize, this.#capacity * 2);
      this.#memory.seal(block);
    }

    return true;
  }

  /** The gaps that became final since the last call, for the recording. */
  takeFinalGaps(): readonly RunGap[] {
    return this.#gapLog.takeFinal();
  }

  /**
   * Seal the block being filled, if it holds anything, so that it can be written away now. The
   * next sample starts a new block.
   */
  sealOpenBlock(): void {
    const last = this.blocks.at(-1);

    if (last && !last.sealed && last.length > 0) {
      this.#memory.seal(last);
    }
  }

  /**
   * Take no more samples: seal the last block, and make the gaps still open final.
   */
  close(): void {
    if (this.#closed) {
      return;
    }

    this.#closed = true;
    this.sealOpenBlock();

    this.#gapLog.endUnstoredRun(Number.NaN, this.storedCount, this.lastTimeUs);
    this.#gapLog.resolvePending(Number.NaN);
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
    this.#gapLog.dropStretch(block, this.blocks[position - 1], this.blocks[position], this.#closed);
    this.rewritten();
  }

  /** Tell the readers of every variable of the run that its history changed in the middle. */
  rewritten(): void {
    for (const record of this.records) {
      record.rewritten();
    }
  }

  /**
   * Forget every sample and gap, so that an open run carries on from nothing.
   */
  clearHistory(): void {
    this.#gapLog.clear();
    this.blocks.length = 0;
    this.firstStoredUs = Number.NaN;
    this.lastTimeUs = Number.NaN;
    this.storedCount = 0;
    this.trimmedCount = 0;
    this.droppedCount = 0;
    this.#capacity = Math.min(this.#blockSize, FIRST_BLOCK_SIZE);
  }

  /** A gap as a recording remembers it. */
  recordedGap(gap: RunGap): RecordedGap {
    return { runId: this.id, ...gap };
  }

  /**
   * Take back a sealed block of a recording, after the ones taken back before it: the reader
   * gives a run's blocks in index order, whatever order the file has them in.
   *
   * @returns The block, or undefined if the memory cap left no room for it.
   * @throws If the block's columns are not the run's, or its index is not past the last one.
   */
  restoreBlock(persisted: BlockData): Block | undefined {
    const length = persisted.time.length;

    if (!fitsColumns(persisted, this.#numericIds, this.#kinds)) {
      throw new Error(`Block ${persisted.ref.index} does not fit the columns of run ${this.id}`);
    }

    const last = this.blocks.at(-1);

    if (last !== undefined && last.ref.index >= persisted.ref.index) {
      throw new Error(
        `Block ${persisted.ref.index} of run ${this.id} comes after block ${last.ref.index}`
      );
    }

    const block = this.#memory.allocate({
      ref: persisted.ref,
      startSample: persisted.startSample,
      capacity: Math.max(LEAF_SIZE, 2 ** Math.ceil(Math.log2(Math.max(1, length)))),
      variableIds: this.#numericIds,
      kinds: this.#kinds,
    });

    if (!block) {
      return undefined;
    }

    for (let sample = 0; sample < length; sample++) {
      for (let column = 0; column < this.#row.length; column++) {
        this.#row[column] = persisted.columns[column].values[sample];
      }

      block.append(persisted.time[sample], this.#row);
    }

    this.#memory.seal(block);
    this.blocks.push(block);
    this.storedCount = Math.max(this.storedCount, persisted.startSample + length);
    this.#nextBlockIndex = Math.max(this.#nextBlockIndex, persisted.ref.index + 1);
    return block;
  }

  /**
   * End a restore: take the run's gaps, take no more samples, and work the counts out from the
   * blocks and gaps taken back.
   *
   * @param gaps Its gaps, in the order they were written.
   */
  finishRestore(gaps: readonly RecordedGap[]): void {
    this.#gapLog.restore(gaps);
    this.#closed = true;
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
    this.#lastSeenUs = Number.isNaN(this.lastTimeUs) ? this.#lastSeenUs : this.lastTimeUs;
  }

  #writableBlock(): Block | undefined {
    const last = this.blocks.at(-1);

    if (last && !last.sealed) {
      return last;
    }

    const block = this.#memory.allocate({
      ref: { runId: this.id, index: this.#nextBlockIndex },
      startSample: this.storedCount,
      capacity: this.#capacity,
      variableIds: this.#numericIds,
      kinds: this.#kinds,
    });

    if (block) {
      this.#nextBlockIndex++;
      this.blocks.push(block);
    }

    return block;
  }
}
