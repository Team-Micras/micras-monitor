import type { ValueType } from '@/core/variables';

import type { Block } from './block';
import { type ColumnKind, columnKindOf, nextUp } from './columns';
import {
  type Decimation,
  DecimationBuilder,
  decimateSegments,
  type DecimationStats,
  firstBlockFrom,
  lowerBound,
  upperBound,
} from './decimation';
import type { BlockLoader } from './memory/block-loader';
import type { StreamRun } from './stream-run';
import type { Boundary, Gap, HistoryMark, SampleRun, SampleValue, TimeRange } from './types';
import type { Segment, VariableHistory } from './variable-history';

/**
 * Extra parameters of a decimation query.
 */
export interface DecimateOptions {
  /**
   * A previous result to reuse. Asked again for the same variable and grid, only the columns
   * from the previous last sample on are recomputed, unless the history changed further back.
   */
  readonly into?: Decimation;

  /** Add what the query read to these counters. */
  readonly stats?: DecimationStats;
}

/**
 * What the store knows about a variable.
 */
export interface VariableInfo {
  /** Its name. */
  readonly name: string;

  /** Its type, once known. */
  readonly type: ValueType | undefined;

  /** How its history is stored, or `none` for blobs. */
  readonly storage: ColumnKind | 'none' | undefined;

  /** Whether a 64 bit integer it held did not fit a float exactly. */
  readonly precisionLost: boolean;

  /** How many of its samples are kept. */
  readonly storedSamples: number;

  /** How many of its samples the source lost. */
  readonly droppedSamples: number;

  /** How many runs it was part of. */
  readonly runs: number;
}

/**
 * What a variable's history holds: its type and storage, and how many samples it keeps, lost
 * and in how many runs.
 */
export function variableInfo(record: VariableHistory): VariableInfo {
  let storedSamples = 0;
  let droppedSamples = 0;

  for (const { run } of record.segments) {
    storedSamples += run.keptCount;
    droppedSamples += run.droppedCount;
  }

  return {
    name: record.name,
    type: record.type,
    storage: record.type === undefined ? undefined : (columnKindOf(record.type) ?? 'none'),
    precisionLost: record.precisionLost,
    storedSamples,
    droppedSamples,
    runs: record.segments.length,
  };
}

/**
 * The span of the samples the runs keep, as a half-open range that holds the last one.
 */
export function rangeOf(runs: Iterable<StreamRun>): TimeRange | undefined {
  let startUs = Number.POSITIVE_INFINITY;
  let lastUs = Number.NEGATIVE_INFINITY;

  for (const run of runs) {
    if (run.keptCount > 0) {
      startUs = Math.min(startUs, run.firstTimeUs);
      lastUs = Math.max(lastUs, run.lastTimeUs);
    }
  }

  return startUs <= lastUs ? { startUs, endUs: nextUp(lastUs) } : undefined;
}

/**
 * The span of a variable's kept history; the same object until its history changes.
 */
export function rangeOfHistory(record: VariableHistory): TimeRange | undefined {
  return record.range(() =>
    rangeOf(record.segments.filter((segment) => segment.column >= 0).map((s) => s.run))
  );
}

/**
 * Whether a window of a variable's history may look different than when a mark was taken:
 * appends at the live end do not touch a window that ends before them.
 *
 * @param current Where the history stands now.
 * @param mark Where it stood.
 * @param window The window.
 */
export function changedSince(
  current: HistoryMark | undefined,
  mark: HistoryMark | undefined,
  window: TimeRange
): boolean {
  if (!current || !mark) {
    return current !== mark;
  }

  if (current.source !== mark.source || current.rewrite !== mark.rewrite) {
    return true;
  }

  return current.version !== mark.version && window.endUs > mark.tailUs;
}

/**
 * The stored samples of a variable's segments in `[startUs, endUs)`, as views into the blocks;
 * evicted blocks are skipped and asked back.
 */
export function* samplesOf(
  segments: readonly Segment[],
  startUs: number,
  endUs: number,
  loader: BlockLoader
): Generator<SampleRun> {
  loader.beginQuery();

  for (const { run, column } of segments) {
    if (column < 0) {
      continue;
    }

    const blocks = run.blocks;

    for (let at = firstBlockFrom(blocks, startUs); at < blocks.length; at++) {
      const block = blocks[at];

      if (block.length === 0) {
        continue;
      }

      if (block.firstTimeUs >= endUs) {
        break;
      }

      const samples = runOf(block, column, startUs, endUs, loader);

      if (samples) {
        yield { runId: run.id, ...samples };
      }
    }
  }
}

/**
 * The stored sample of a variable's segments at a time, or the last one before it. Undefined
 * before the first sample, or while its block is being read back.
 */
export function valueAt(
  segments: readonly Segment[],
  timeUs: number,
  loader: BlockLoader
): SampleValue | undefined {
  loader.beginQuery();

  for (let index = segments.length - 1; index >= 0; index--) {
    const { run, column } = segments[index];
    const block = blockAt(run.blocks, timeUs);

    if (column < 0 || !block) {
      continue;
    }

    loader.markUsed(block);
    const time = block.time;
    const columns = block.columns;

    if (!time || !columns) {
      loader.request(block);
      return undefined;
    }

    const at = upperBound(time, timeUs, 0, block.length) - 1;
    return { value: columns[column][at], timeUs: time[at] };
  }

  return undefined;
}

/**
 * The minimum and maximum of a variable per pixel column of `[startUs, endUs)`, reusing a
 * previous result over the same grid when its history only grew.
 *
 * @param record The variable's history, if it has one.
 * @param startUs The start of the window, inclusive.
 * @param endUs The end of the window, exclusive.
 * @param pixels How many columns to split it into.
 * @param boundaries Where no line is drawn across.
 * @param loader How to reach raw samples.
 * @param options A result to reuse and counters to fill.
 */
export function decimate(
  record: VariableHistory | undefined,
  startUs: number,
  endUs: number,
  pixels: number,
  boundaries: readonly Boundary[],
  loader: BlockLoader,
  options: DecimateOptions
): Decimation {
  const into = options.into instanceof DecimationBuilder ? options.into : new DecimationBuilder();

  if (!record) {
    into.reset(startUs, endUs, pixels);
    return into;
  }

  const mark = record.mark;
  const previous = into.mark;
  const reusable =
    into.source === record &&
    previous !== undefined &&
    previous.rewrite === mark.rewrite &&
    into.sameGrid(startUs, endUs, pixels);

  if (reusable && previous.version === mark.version) {
    return into;
  }

  if (reusable) {
    into.resetFrom(into.columnOf(previous.tailUs));
  } else {
    into.reset(startUs, endUs, pixels);
  }

  loader.beginQuery();
  decimateSegments(into, record.segments, boundaries, loader, options.stats);
  into.source = record;
  into.mark = mark;
  return into;
}

/**
 * Why a variable's segments have no samples in parts of `[startUs, endUs)`: time between its
 * runs, dropped samples and samples not kept, ordered by start.
 */
export function gapsOf(segments: readonly Segment[], startUs: number, endUs: number): Gap[] {
  const found: Gap[] = [];
  let coveredUntil = Number.NaN;

  for (const { run, column } of segments) {
    if (column < 0) {
      continue;
    }

    if (run.storedCount > 0) {
      if (
        run.firstStoredUs > coveredUntil &&
        overlaps(coveredUntil, run.firstStoredUs, startUs, endUs)
      ) {
        found.push({ kind: 'not-streamed', startUs: coveredUntil, endUs: run.firstStoredUs });
      }

      coveredUntil = Number.isNaN(coveredUntil)
        ? run.lastTimeUs
        : Math.max(coveredUntil, run.lastTimeUs);
    }

    for (const gap of run.gaps) {
      const gapStart = Number.isNaN(gap.startUs) ? gap.untilUs : gap.startUs;

      if (overlaps(gapStart, gap.untilUs, startUs, endUs)) {
        found.push({ kind: gap.kind, startUs: gapStart, endUs: gap.untilUs, count: gap.count });
      }
    }

    if (run.unstoredRun > 0 && overlaps(run.unstoredFrom, Number.NaN, startUs, endUs)) {
      found.push({
        kind: 'not-stored',
        startUs: run.unstoredFrom,
        endUs: Number.NaN,
        count: run.unstoredRun,
      });
    }
  }

  return found.toSorted((left, right) => left.startUs - right.startUs);
}

function blockAt(blocks: readonly Block[], timeUs: number): Block | undefined {
  for (let at = Math.min(firstBlockFrom(blocks, timeUs), blocks.length - 1); at >= 0; at--) {
    const block = blocks[at];

    if (block.length > 0 && block.firstTimeUs <= timeUs) {
      return block;
    }
  }

  return undefined;
}

function runOf(
  block: Block,
  column: number,
  startUs: number,
  endUs: number,
  loader: BlockLoader
): Omit<SampleRun, 'runId'> | undefined {
  loader.markUsed(block);
  const time = block.time;
  const columns = block.columns;

  if (!time || !columns) {
    loader.request(block);
    return undefined;
  }

  const first = lowerBound(time, startUs, 0, block.length);
  const end = lowerBound(time, endUs, first, block.length);

  if (first >= end) {
    return undefined;
  }

  return { time: time.subarray(first, end), values: columns[column].subarray(first, end) };
}

function overlaps(startUs: number, endUs: number, fromUs: number, toUs: number): boolean {
  return startUs < toUs && (Number.isNaN(endUs) || endUs >= fromUs);
}
