import type { BlockBacking, BlockData } from '@/history/block-backing';
import { HistoryStore, type HistoryStoreOptions } from '@/history/history-store';
import type {
  Boundary,
  HistoryVariable,
  RecordedGap,
  RecordedRun,
  RecordedValue,
} from '@/history/types';

/**
 * A run of a saved recording, as {@link loadRecording} takes it.
 */
export interface StoredRun {
  /** The run, with the names its variables had. */
  readonly run: RecordedRun;

  /** Its gaps, in the order they were written; a later one with the same start replaces one before. */
  readonly gaps: readonly RecordedGap[];

  /** Its blocks, in index order; decoded one at a time as they are taken. */
  readonly blocks: Iterable<BlockData>;
}

/**
 * A saved recording, as {@link loadRecording} takes it.
 */
export interface StoredRecording {
  /** The robot's schema when the session was recorded. */
  readonly schema: readonly HistoryVariable[];

  /** Every run, in the order they opened. */
  readonly runs: readonly StoredRun[];

  /** Every boundary. */
  readonly boundaries: readonly Boundary[];

  /** The values outside the stored streams, in the order they came. */
  readonly values: readonly RecordedValue[];
}

/**
 * A store filled from a recording.
 */
export interface LoadedRecording {
  /** The store, holding the whole recording with every run closed. */
  readonly store: HistoryStore;

  /** How many blocks did not fit under the store's memory cap and were left out. */
  readonly skipped: number;
}

/**
 * Fill a new store with a saved recording, to read it: its schema, runs, blocks, gaps,
 * boundaries and values. Every run ends closed. Each block counts as having a copy in `source`,
 * so under the memory cap it leaves memory, oldest first, and comes back from there when a query
 * needs its raw samples; its pyramid stays. The latest value of a numeric variable is its last
 * stored sample.
 *
 * @param recording What to load; its blocks are decoded one at a time.
 * @param source Where the blocks can be read back from.
 * @param options How to set up the store.
 * @throws If a run appears twice, or a block does not fit its run or comes out of order.
 */
export function loadRecording(
  recording: StoredRecording,
  source: BlockBacking,
  options: HistoryStoreOptions
): LoadedRecording {
  const store = new HistoryStore(options);
  store.setSchema(recording.schema);
  let skipped = 0;

  for (const { run, blocks, gaps } of recording.runs) {
    skipped += store.restoreRun(run, blocks, latestGaps(gaps), source);
  }

  for (const { kind, timeUs } of recording.boundaries.toSorted((a, b) => a.timeUs - b.timeUs)) {
    store.markBoundary(kind, timeUs);
  }

  for (const value of recording.values) {
    store.restoreValue(value);
  }

  return { store, skipped };
}

/**
 * The gaps of a run as they ended up: a recorder writes a gap again when it grows, so the last
 * gap written with a start replaces the ones before it; ordered by index, and among gaps of one
 * index by when they were last written.
 */
function latestGaps(gaps: readonly RecordedGap[]): RecordedGap[] {
  const byStart = new Map<number, RecordedGap>();

  for (const gap of gaps) {
    byStart.delete(gap.startUs);
    byStart.set(gap.startUs, gap);
  }

  return [...byStart.values()].toSorted((left, right) => left.index - right.index);
}
