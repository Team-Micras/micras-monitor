import type { Block, BlockLayout } from './block';
import { type ColumnKind, columnKindOf, isWideInteger, toNumber } from './storage';
import type { EpochSpec, TelemetryValue, VariableSpec } from './types';

/**
 * How many samples the first block of an epoch holds; each next block holds twice as many, up to
 * the store's block size, so that short epochs take little memory.
 */
export const FIRST_BLOCK_SIZE = 1024;

/**
 * Samples missing inside an epoch, before the sample stored at {@link EpochGap.index}.
 */
export interface EpochGap {
  /** Whether they never arrived or were not kept. */
  readonly kind: 'dropped' | 'not-stored';

  /** The epoch sample index of the first stored sample after the gap. */
  readonly index: number;

  /** How many samples are missing. */
  count: number;

  /** The time of the last stored sample before the gap, or NaN if there is none. */
  readonly afterUs: number;

  /** The time of the first stored sample after the gap, or NaN until it arrives. */
  untilUs: number;
}

/**
 * What an epoch needs from the store to hold its samples.
 */
export interface BlockSource {
  /**
   * A new block, or undefined if the memory cap does not allow one.
   */
  allocate(layout: BlockLayout): Block | undefined;

  /**
   * A block will take no more samples.
   */
  seal(block: Block): void;
}

/**
 * The samples of one definition of a stream group.
 *
 * The robot restarts a group's sequence numbers whenever the group is defined, so each epoch
 * tracks them on its own: a jump in the sequence is a gap of dropped samples, which is different
 * from the time outside any epoch, when the variable was not streamed at all.
 */
export class Epoch {
  /** The session's id for the epoch. */
  readonly id: number;

  /** The robot's group slot. */
  readonly groupId: number;

  /** The variables of each sample, in wire order. */
  readonly variables: readonly VariableSpec[];

  /** For each variable, its column among the numeric ones, or -1 for a blob. */
  readonly columnOf: readonly number[];

  /** For each variable, whether its values may lose precision as floats. */
  readonly wide: readonly boolean[];

  /** The blocks, oldest first. */
  readonly blocks: Block[] = [];

  /** Dropped and unstored samples, in the order they happened. */
  readonly gaps: EpochGap[] = [];

  /** The time of the first stored sample, or NaN. */
  firstTimeUs = Number.NaN;

  /** The time of the last stored sample, or NaN. */
  lastTimeUs = Number.NaN;

  /** How many samples were stored. */
  storedCount = 0;

  /** How many samples the sequence numbers show as lost. */
  droppedCount = 0;

  private readonly numericIds: readonly number[];
  private readonly kinds: readonly ColumnKind[];
  private readonly row: Float64Array;
  private expectedSequence: number | undefined;
  private pendingUnstored = 0;
  private lastSeenUs = Number.NEGATIVE_INFINITY;
  private unresolvedGap = 0;
  private isClosed = false;

  /**
   * @param spec The group layout.
   * @param blockSize How many samples a block holds at most.
   * @param sequenceModulus Where the robot's sequence numbers wrap.
   * @param source Where blocks come from.
   */
  constructor(
    spec: EpochSpec,
    private readonly blockSize: number,
    private readonly sequenceModulus: number,
    private readonly source: BlockSource
  ) {
    this.id = spec.epochId;
    this.groupId = spec.groupId;
    this.variables = [...spec.variables];

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
    this.wide = this.variables.map((variable) => isWideInteger(variable.type));
    this.row = new Float64Array(numericIds.length);
  }

  /** Whether the group was redefined or the link lost the robot since. */
  get closed(): boolean {
    return this.isClosed;
  }

  /** How many samples arrived since the last stored one without being kept. */
  get unstoredRun(): number {
    return this.pendingUnstored;
  }

  /**
   * Account for an arriving sample before it is stored: its time and its sequence number.
   *
   * A sequence number up to half the modulus behind the expected one is a duplicate or a late
   * sample, which the ordered link should never deliver; it is refused rather than counted as a
   * wrap of dropped samples.
   *
   * @param sequence The sample's sequence number.
   * @param timeUs When it was taken.
   * @returns How many samples before it never arrived, or -1 if it is to be ignored.
   * @throws If the time is before the previous sample's.
   */
  receive(sequence: number, timeUs: number): number {
    if (timeUs < this.lastSeenUs) {
      throw new RangeError(
        `Epoch ${this.id} got a sample at ${timeUs} µs after one at ${this.lastSeenUs} µs`
      );
    }

    const expected = this.expectedSequence;
    const modulus = this.sequenceModulus;
    const missing = expected === undefined ? sequence : (sequence - expected + modulus) % modulus;

    if (expected !== undefined && missing > modulus / 2) {
      return -1;
    }

    this.expectedSequence = (sequence + 1) % modulus;
    this.lastSeenUs = timeUs;

    if (missing > 0) {
      this.recordGap('dropped', missing);
    }

    return missing;
  }

  /**
   * Account for samples known to be lost after the last one, so that the next sequence number is
   * not counted against them again. The count must be exact: those sequence numbers are skipped.
   *
   * @param count How many samples were lost.
   */
  markDropped(count: number): void {
    if (count <= 0) {
      return;
    }

    this.expectedSequence = ((this.expectedSequence ?? 0) + count) % this.sequenceModulus;
    this.recordGap('dropped', count);
  }

  /**
   * Store a sample, if the memory cap allows.
   *
   * @param timeUs When it was taken.
   * @param values Its values, in wire order.
   * @returns Whether it was stored.
   */
  store(timeUs: number, values: ArrayLike<TelemetryValue>): boolean {
    const block = this.writableBlock();

    if (!block) {
      this.pendingUnstored++;
      return false;
    }

    if (this.pendingUnstored > 0) {
      this.recordGap('not-stored', this.pendingUnstored);
      this.pendingUnstored = 0;
    }

    for (let variable = 0; variable < this.columnOf.length; variable++) {
      const column = this.columnOf[variable];

      if (column >= 0) {
        this.row[column] = toNumber(values[variable]);
      }
    }

    block.append(timeUs, this.row);

    if (this.storedCount === 0) {
      this.firstTimeUs = timeUs;
    }

    this.storedCount++;
    this.lastTimeUs = timeUs;

    while (this.unresolvedGap < this.gaps.length) {
      this.gaps[this.unresolvedGap++].untilUs = timeUs;
    }

    if (block.full) {
      this.source.seal(block);
    }

    return true;
  }

  /**
   * Take no more samples: seal the last block and keep a trailing unstored run as a gap.
   */
  close(): void {
    if (this.isClosed) {
      return;
    }

    this.isClosed = true;
    const last = this.blocks.at(-1);

    if (last && !last.sealed) {
      this.source.seal(last);
    }

    if (this.pendingUnstored > 0) {
      this.recordGap('not-stored', this.pendingUnstored);
      this.pendingUnstored = 0;
    }
  }

  private writableBlock(): Block | undefined {
    const last = this.blocks.at(-1);

    if (last && !last.sealed) {
      return last;
    }

    const block = this.source.allocate({
      ref: { epochId: this.id, index: this.blocks.length },
      startSample: this.storedCount,
      capacity: Math.min(this.blockSize, FIRST_BLOCK_SIZE * 2 ** this.blocks.length),
      variableIds: this.numericIds,
      kinds: this.kinds,
    });

    if (block) {
      this.blocks.push(block);
    }

    return block;
  }

  private recordGap(kind: EpochGap['kind'], count: number): void {
    if (kind === 'dropped') {
      this.droppedCount += count;
    }

    const last = this.gaps.at(-1);

    if (last && last.kind === kind && last.index === this.storedCount) {
      last.count += count;
      return;
    }

    this.gaps.push({
      kind,
      index: this.storedCount,
      count,
      afterUs: this.lastTimeUs,
      untilUs: Number.NaN,
    });
  }
}
