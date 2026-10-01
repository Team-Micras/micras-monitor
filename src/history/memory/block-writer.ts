import type { Block } from '../block';
import type { BlockBacking } from '../block-backing';

const FIRST_BACKOFF_MS = 1000;
const LAST_BACKOFF_MS = 60_000;

/**
 * Keeps the state of recording for {@link BlockMemory}: where sealed blocks are written, the
 * writes under way, when the blocks being filled are next due, and the backoff of failing writes.
 *
 * A write that fails is tried again once a backoff has passed, doubling from 1 s up to a minute;
 * {@link failed} and {@link recovered} say when writes start and stop failing, so that the user
 * hears once of each.
 */
export class BlockWriter {
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
   * @param now Wall time in milliseconds.
   * @param flushIntervalMs How often the blocks being filled are sealed and written.
   */
  constructor(now: () => number, flushIntervalMs: number) {
    this.#now = now;
    this.#flushIntervalMs = flushIntervalMs;
  }

  /** Where blocks are written while recording. */
  get target(): BlockBacking | undefined {
    return this.#target;
  }

  /** How many writes are under way. */
  get pendingWrites(): number {
    return this.#pendingWrites;
  }

  /** Whether writes to the persistence layer are failing. */
  get failing(): boolean {
    return this.#failing;
  }

  /** Whether writes may be tried now: recording, and not waiting out a backoff. */
  get canWrite(): boolean {
    return this.#target !== undefined && !(this.#failing && this.#now() < this.#retryAtMs);
  }

  /** Start recording into a persistence layer, with no failure behind. */
  start(target: BlockBacking): void {
    this.#target = target;
    this.#failing = false;
    this.#backoffMs = FIRST_BACKOFF_MS;
    this.#retryAtMs = 0;
    this.#lastFlushMs = this.#now();
  }

  /** Let the next writes be tried at once, whatever the backoff, as recording stops. */
  retryNow(): void {
    this.#retryAtMs = 0;
  }

  /**
   * Stop recording.
   *
   * @returns A promise that settles once every write under way has.
   */
  stop(): Promise<void> {
    this.#target = undefined;
    return Promise.all(this.#writes).then(() => undefined);
  }

  /** Whether, while recording, the flush interval passed since the last flush; then it starts again. */
  flushDue(): boolean {
    if (!this.#target) {
      return false;
    }

    const now = this.#now();

    if (now - this.#lastFlushMs < this.#flushIntervalMs) {
      return false;
    }

    this.#lastFlushMs = now;
    return true;
  }

  /** Keep a write in the ones {@link stop} waits for, until it settles. */
  track(write: Promise<void>): void {
    this.#writes.add(write);
    void write.finally(() => this.#writes.delete(write));
  }

  /** A write of a block started. */
  began(block: Block): void {
    block.writing = true;
    this.#pendingWrites++;
  }

  /**
   * A write of a block ended.
   *
   * @param current Whether the memory was not reset since it started.
   */
  ended(block: Block, current: boolean): void {
    block.writing = false;

    if (current) {
      this.#pendingWrites--;
    }
  }

  /**
   * A write failed: wait out the backoff before the next ones, doubling it.
   *
   * @returns Whether writes just started failing.
   */
  failed(): boolean {
    const now = this.#now();

    if (now >= this.#retryAtMs) {
      this.#retryAtMs = now + this.#backoffMs;
      this.#backoffMs = Math.min(LAST_BACKOFF_MS, 2 * this.#backoffMs);
    }

    const started = !this.#failing;
    this.#failing = true;
    return started;
  }

  /**
   * A write succeeded: the backoff starts over.
   *
   * @returns Whether writes just stopped failing.
   */
  recovered(): boolean {
    this.#backoffMs = FIRST_BACKOFF_MS;
    const stopped = this.#failing;
    this.#failing = false;
    return stopped;
  }

  /** Stop recording and forget the writes under way, as the memory forgets every block. */
  reset(): void {
    this.#pendingWrites = 0;
    this.#writes.clear();
    this.#target = undefined;
    this.#failing = false;
  }
}
