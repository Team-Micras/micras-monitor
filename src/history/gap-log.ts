import type { Block } from './block';
import type { BlockMemory } from './memory/block-memory';
import type { RecordedGap, RunGap } from './types';

/** What one gap record is counted as against the memory cap. */
export const GAP_BYTES = 64;

const NO_GAPS: readonly RunGap[] = [];

/**
 * The gaps of one run, in sample order: samples the source lost, and samples the memory cap kept
 * out of the history or made the store let go of.
 *
 * A gap is open while the sample after it has not arrived; once it has, or the run closed, the
 * gap is final and waits in {@link takeFinal} for the recording. Each gap counts against the
 * memory cap.
 */
export class GapLog {
  readonly #memory: BlockMemory;
  readonly #gaps: RunGap[] = [];
  readonly #pending: RunGap[] = [];
  #breaks: RunGap[] | undefined = [];
  #final: RunGap[] = [];
  #unstored = 0;
  #unstoredFromUs = Number.NaN;

  /**
   * @param memory Where the gaps are counted.
   */
  constructor(memory: BlockMemory) {
    this.#memory = memory;
  }

  /** Every gap, in sample order. */
  get gaps(): readonly RunGap[] {
    return this.#gaps;
  }

  /**
   * The gaps a line can break at: those with a sample before them, ordered by its time. A gap with
   * no sample before it, as when the memory cap let go of the first blocks of the run, has no line
   * to break and is left out. The gaps themselves are kept in sample order, which letting go of a
   * block can leave out of time order, so this list is sorted again after a block is let go of.
   */
  get breaks(): readonly RunGap[] {
    this.#breaks ??= this.#gaps
      .filter((gap) => !Number.isNaN(gap.afterUs))
      .toSorted((left, right) => left.afterUs - right.afterUs);
    return this.#breaks;
  }

  /** How many samples arrived since the last stored one without being kept. */
  get unstoredRun(): number {
    return this.#unstored;
  }

  /** The time of the first sample of the current unstored run, or NaN. */
  get unstoredFrom(): number {
    return this.#unstoredFromUs;
  }

  /** The gaps that became final since the last call, oldest first. */
  takeFinal(): readonly RunGap[] {
    if (this.#final.length === 0) {
      return NO_GAPS;
    }

    const final = this.#final;
    this.#final = [];
    return final;
  }

  /**
   * Samples the source lost before the sample about to be stored; a loss right after another one
   * still open adds to it.
   *
   * @param count How many.
   * @param index The run sample index the next stored sample will have.
   * @param afterUs The time of the last stored sample, or NaN.
   */
  addDropped(count: number, index: number, afterUs: number): void {
    this.#add('dropped', count, afterUs, index, afterUs, true);
  }

  /** A sample arrived that the memory cap kept out of the history. */
  noteUnstored(timeUs: number): void {
    if (this.#unstored === 0) {
      this.#unstoredFromUs = timeUs;
    }

    this.#unstored++;
  }

  /**
   * End the stretch of samples not kept, if any, as a final gap.
   *
   * @param untilUs The time of the sample stored after it, or NaN when the run closed.
   * @param index The run sample index of that sample.
   * @param afterUs The time of the last stored sample before it, or NaN.
   */
  endUnstoredRun(untilUs: number, index: number, afterUs: number): void {
    if (this.#unstored === 0) {
      return;
    }

    const gap = this.#add(
      'not-stored',
      this.#unstored,
      this.#unstoredFromUs,
      index,
      afterUs,
      false
    );
    gap.untilUs = untilUs;
    this.#unstored = 0;
    this.#unstoredFromUs = Number.NaN;

    if (!this.#pending.includes(gap)) {
      this.#final.push(gap);
    }
  }

  /**
   * Close the open gaps: the sample after them arrived, or the run closed.
   *
   * @param untilUs The time of that sample, or NaN.
   */
  resolvePending(untilUs: number): void {
    for (const gap of this.#pending) {
      gap.untilUs = untilUs;
      this.#final.push(gap);
    }

    this.#pending.length = 0;
  }

  /**
   * Keep the stretch of a block the memory cap let go of as a gap of samples not stored, merged
   * with a gap of that kind just before it, and taking in the gaps inside it.
   *
   * @param block The block let go of.
   * @param previous The block before it in the run, if any.
   * @param next The block after it in the run, if any.
   * @param closed Whether the run is closed, so that no sample can come after.
   */
  dropStretch(
    block: Block,
    previous: Block | undefined,
    next: Block | undefined,
    closed: boolean
  ): void {
    const start = block.startSample;
    const end = start + block.length;
    this.#breaks = undefined;
    const inside = this.#gaps.filter((gap) => gap.index > start && gap.index < end);

    for (const gap of inside) {
      this.#gaps.splice(this.#gaps.indexOf(gap), 1);
      this.#memory.account(-GAP_BYTES);
    }

    const before = this.#gaps.find((gap) => gap.kind === 'not-stored' && gap.index === start);
    const gap: RunGap = before ?? {
      kind: 'not-stored',
      index: end,
      count: 0,
      startUs: block.firstTimeUs,
      afterUs: previous?.lastTimeUs ?? Number.NaN,
      untilUs: Number.NaN,
    };
    gap.index = end;
    gap.count += block.length;
    gap.untilUs = next?.firstTimeUs ?? Number.NaN;

    if (!before) {
      const after = this.#gaps.findIndex((other) => other.index > end);
      this.#gaps.splice(after < 0 ? this.#gaps.length : after, 0, gap);
      this.#memory.account(GAP_BYTES);
    }

    if (!next && !closed && !this.#pending.includes(gap)) {
      this.#pending.push(gap);
    }
  }

  /** Forget every gap. */
  clear(): void {
    this.#memory.account(-GAP_BYTES * this.#gaps.length);
    this.#gaps.length = 0;
    this.#breaks = [];
    this.#pending.length = 0;
    this.#final = [];
    this.#unstored = 0;
    this.#unstoredFromUs = Number.NaN;
  }

  /**
   * Take back the gaps of a recording, final. A recorder writes a gap again when it grows, so
   * the last gap written with a start replaces the ones before it; they end up ordered by index,
   * and among gaps of one index by when they were last written.
   *
   * @param gaps The gaps, in the order they were written.
   */
  restore(gaps: readonly RecordedGap[]): void {
    const byStart = new Map<number, RecordedGap>();

    for (const gap of gaps) {
      byStart.delete(gap.startUs);
      byStart.set(gap.startUs, gap);
    }

    this.#breaks = undefined;
    const latest = [...byStart.values()].toSorted((left, right) => left.index - right.index);

    for (const { kind, index, count, startUs, afterUs, untilUs } of latest) {
      this.#gaps.push({ kind, index, count, startUs, afterUs, untilUs });
      this.#memory.account(GAP_BYTES);
    }
  }

  #add(
    kind: RunGap['kind'],
    count: number,
    startUs: number,
    index: number,
    afterUs: number,
    pending: boolean
  ): RunGap {
    const last = this.#gaps.at(-1);

    if (last && last.kind === kind && last.index === index && this.#pending.includes(last)) {
      last.count += count;
      return last;
    }

    const gap: RunGap = { kind, index, count, startUs, afterUs, untilUs: Number.NaN };
    this.#gaps.push(gap);
    this.#memory.account(GAP_BYTES);

    if (!Number.isNaN(afterUs)) {
      this.#breaks?.push(gap);
    }

    if (pending) {
      this.#pending.push(gap);
    }

    return gap;
  }
}
