import type { PersistedBlock, StoredEpoch, StoredSession } from './persistence';
import { RecordingBlocks } from './recorder';
import {
  decodeBlock,
  decodeLocated,
  peekBlock,
  RECORD_OVERHEAD,
  scanRecording,
  type LocatedRecord,
  type RecordingDamage,
  type RecordingHeader,
} from './recording';
import type { RecordingFile } from './recording-file';
import type { TelemetryStore } from './store';
import type { Boundary, RecordedEpoch, RecordedGap, RecordedValue, TimeRange } from './types';
import { nextUp } from './window';

/**
 * What a recording file held when it was read.
 */
export interface RecordingSummary {
  /** Its header. */
  readonly header: RecordingHeader;

  /** Its size in bytes. */
  readonly bytes: number;

  /** Where its whole records end; less than {@link bytes} when the tail was cut short. */
  readonly validEnd: number;

  /** Where the last, incomplete record starts, when the file was cut short. */
  readonly truncatedAt?: number;

  /** Records skipped in the middle because they were damaged. */
  readonly damaged: readonly RecordingDamage[];

  /** How many blocks it holds. */
  readonly blocks: number;

  /** How many samples its blocks hold. */
  readonly samples: number;

  /** Blocks whose epoch was never recorded, which cannot be placed. */
  readonly unplaced: number;

  /** The span of its samples, if it holds any. */
  readonly range: TimeRange | undefined;
}

interface EpochParts {
  readonly epoch: RecordedEpoch;
  readonly gaps: RecordedGap[];
  readonly blocks: Map<number, LocatedRecord>;
}

/**
 * A recording file read once from end to end: what it holds, ready to fill a store, whose blocks
 * are then read back from the file as needed.
 */
export class SavedRecording {
  /**
   * @param summary What the file holds.
   * @param blocks Where its blocks are.
   * @param session What a store loads.
   */
  private constructor(
    readonly summary: RecordingSummary,
    readonly blocks: RecordingBlocks,
    private session: StoredSession | undefined
  ) {}

  /**
   * Read a recording file whole. A tail cut short or a damaged record does not stop it: the
   * summary says what was left out.
   *
   * @throws If the file is not a recording, or its version is not supported.
   */
  static async read(file: RecordingFile): Promise<SavedRecording> {
    const size = await file.size();
    const bytes = await file.read(0, size);
    const scan = scanRecording(bytes);
    const epochs = new Map<number, EpochParts>();
    const boundaries: Boundary[] = [];
    const values: RecordedValue[] = [];
    const orphans: LocatedRecord[] = [];

    for (const located of scan.records) {
      if (located.kind === 'block') {
        const { ref } = peekBlock(located.payload);
        const parts = epochs.get(ref.epochId);

        if (parts) {
          parts.blocks.set(ref.index, located);
        } else {
          orphans.push(located);
        }

        continue;
      }

      const record = decodeLocated(located);

      if (record.kind === 'epoch') {
        epochs.set(record.epoch.epochId, { epoch: record.epoch, gaps: [], blocks: new Map() });
      } else if (record.kind === 'gap') {
        epochs.get(record.gap.epochId)?.gaps.push(record.gap);
      } else if (record.kind === 'boundary') {
        boundaries.push(record.boundary);
      } else if (record.kind === 'value') {
        values.push(record.value);
      }
    }

    const unplaced = orphans.filter((located) => {
      const { ref } = peekBlock(located.payload);
      const parts = epochs.get(ref.epochId);
      parts?.blocks.set(ref.index, located);
      return parts === undefined;
    }).length;

    const blocks = new RecordingBlocks(file);
    let samples = 0;
    let blockCount = 0;
    let firstUs = Number.POSITIVE_INFINITY;
    let lastUs = Number.NEGATIVE_INFINITY;

    for (const parts of epochs.values()) {
      for (const located of parts.blocks.values()) {
        const { ref, length } = peekBlock(located.payload);
        blocks.place(ref, {
          offset: located.offset + RECORD_OVERHEAD,
          size: located.payload.byteLength,
        });
        blockCount++;
        samples += length;

        if (length > 0) {
          const [first, last] = blockSpan(located.payload, length);
          firstUs = Math.min(firstUs, first);
          lastUs = Math.max(lastUs, last);
        }
      }
    }

    const summary: RecordingSummary = {
      header: scan.header,
      bytes: size,
      validEnd: scan.validEnd,
      ...(scan.truncatedAt === undefined ? {} : { truncatedAt: scan.truncatedAt }),
      damaged: scan.damaged ?? [],
      blocks: blockCount,
      samples,
      unplaced,
      range: firstUs <= lastUs ? { startUs: firstUs, endUs: nextUp(lastUs) } : undefined,
    };
    const session: StoredSession = {
      schema: scan.header.schema.map(({ id, name, type }) => ({ id, name, type })),
      epochs: [...epochs.values()].map((parts) => storedEpoch(parts)),
      boundaries,
      values,
    };
    return new SavedRecording(summary, blocks, session);
  }

  /**
   * Fill an empty store with the recording, whose blocks then come back from the file when the
   * store needs them. It lets go of the bytes read, so it can be done once.
   *
   * @returns How many blocks did not fit under the store's memory cap.
   * @throws If it was done before.
   */
  loadInto(store: TelemetryStore): number {
    const session = this.session;

    if (!session) {
      throw new Error('The recording was loaded already');
    }

    this.session = undefined;
    return store.load(session, this.blocks);
  }
}

function storedEpoch(parts: EpochParts): StoredEpoch {
  const indices = [...parts.blocks.keys()].toSorted((left, right) => left - right);
  return {
    epoch: parts.epoch,
    gaps: parts.gaps,
    blocks: decodeInOrder(parts.blocks, indices),
  };
}

function* decodeInOrder(
  blocks: ReadonlyMap<number, LocatedRecord>,
  indices: readonly number[]
): Generator<PersistedBlock> {
  for (const index of indices) {
    const located = blocks.get(index);

    if (located) {
      yield decodeBlock(located.payload);
    }
  }
}

function blockSpan(payload: Uint8Array, length: number): [number, number] {
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const columns = view.getUint32(16, true);
  const times = 20 + 8 * columns;
  return [view.getFloat64(times, true), view.getFloat64(times + 8 * (length - 1), true)];
}
