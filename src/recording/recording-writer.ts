import type { BlockPersistence, BlockRef, PersistedBlock } from '@/history/block-backing';
import type { TelemetryStore } from '@/history/history-store';

import {
  decodeBlock,
  encodeRecordingHeader,
  encodeRecordingRecord,
  RECORD_OVERHEAD,
  recordOf,
  type RecordingHeader,
  type RecordingRecord,
} from './recording';
import type { RecordingFile } from './recording-file';

/**
 * Where a block's record sits in a recording file.
 */
export interface BlockLocation {
  /** Where its payload starts. */
  readonly offset: number;

  /** How many bytes its payload takes. */
  readonly size: number;
}

/**
 * How far a recorder got, for the recording indicator.
 */
export interface RecorderStats {
  /** Bytes known to be in the file. */
  readonly bytes: number;

  /** Blocks written. */
  readonly blocks: number;

  /** Samples in the blocks written. */
  readonly samples: number;

  /** Whether the last write failed. */
  readonly failing: boolean;

  /** Whether the recorder stopped taking what the store records. */
  readonly stopped: boolean;
}

interface Pending {
  readonly bytes: Uint8Array;
  readonly block?: { readonly ref: BlockRef; readonly length: number };
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
}

/**
 * The key of a block reference in a map.
 */
export function blockKey(ref: BlockRef): string {
  return `${ref.epochId}:${ref.index}`;
}

/**
 * The blocks of a recording file, read back by where their records are: the persistence layer
 * of a store loaded from the file, and of a store recording into it.
 */
export class RecordingBlocks implements BlockPersistence {
  private readonly locations = new Map<string, BlockLocation>();
  private readCount = 0;

  /**
   * @param file The recording.
   */
  constructor(private readonly file: RecordingFile) {}

  /** Note where a block's record is. */
  place(ref: BlockRef, location: BlockLocation): void {
    this.locations.set(blockKey(ref), location);
  }

  /** How many blocks were read back from the file. */
  get reads(): number {
    return this.readCount;
  }

  /** Whether a block's record is known. */
  has(ref: BlockRef): boolean {
    return this.locations.has(blockKey(ref));
  }

  /** {@inheritDoc BlockPersistence.write} */
  write(block: PersistedBlock): Promise<void> {
    return Promise.reject(
      new Error(`Block ${block.ref.index} of epoch ${block.ref.epochId}: the file is read only`)
    );
  }

  /** {@inheritDoc BlockPersistence.read} */
  async read(ref: BlockRef): Promise<PersistedBlock> {
    const location = this.locations.get(blockKey(ref));

    if (!location) {
      throw new Error(`No block ${ref.index} of epoch ${ref.epochId} in the recording`);
    }

    const block = decodeBlock(await this.file.read(location.offset, location.size));
    this.readCount++;
    return block;
  }
}

/**
 * Writes a store's session to a recording file as it grows: the header, then what the store
 * already holds, then every block and ingestion event as they come. It is the store's persistence
 * layer while recording, so blocks written can leave memory and come back from the file.
 *
 * Writes go one at a time, each batching whatever queued up behind the previous one. A write
 * that fails is reported and not lost: its events are written again with the next write, and the
 * store writes its blocks again after a backoff. Records go at the end of what is known to be in
 * the file, so a write cut short is overwritten by the next one.
 */
export class SessionRecorder implements BlockPersistence {
  private readonly blocks: RecordingBlocks;
  private readonly listeners = new Set<() => void>();
  private queue: Pending[] = [];
  private draining: Promise<void> | undefined;
  private committed: number;
  private writtenBlocks = 0;
  private writtenSamples = 0;
  private failing = false;
  private stopped = false;
  private detach: (() => void) | undefined;
  private snapshot: RecorderStats;

  private constructor(
    private readonly file: RecordingFile,
    headerBytes: number,
    private readonly onError: (error: unknown) => void
  ) {
    this.blocks = new RecordingBlocks(file);
    this.committed = headerBytes;
    this.snapshot = this.stats();
  }

  /**
   * Start recording a store into an empty file: write the header, then take the store's whole
   * session so far and everything after, until {@link stop}.
   *
   * @param file An empty file.
   * @param header The recording's header.
   * @param store The store to record.
   * @param onError Hears about each write that fails.
   */
  static async start(
    file: RecordingFile,
    header: RecordingHeader,
    store: TelemetryStore,
    onError: (error: unknown) => void = () => undefined
  ): Promise<SessionRecorder> {
    const head = encodeRecordingHeader(header);
    await file.truncate(0);
    await file.write(0, head);
    const recorder = new SessionRecorder(file, head.byteLength, onError);
    const take = (record: RecordingRecord) => void recorder.enqueue(record).catch(() => undefined);
    store.replayIngestion((event) => take(recordOf(event)));
    recorder.detach = store.onIngestion((event) => take(recordOf(event)));
    store.startRecording(recorder);
    return recorder;
  }

  /** How far the recorder got; the same object until it changes. */
  get status(): RecorderStats {
    return this.snapshot;
  }

  /** Hear about changes of {@link status}; returns the function that stops it. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** {@inheritDoc BlockPersistence.write} */
  write(block: PersistedBlock): Promise<void> {
    return this.enqueue({ kind: 'block', block }, { ref: block.ref, length: block.time.length });
  }

  /** {@inheritDoc BlockPersistence.read} */
  read(ref: BlockRef): Promise<PersistedBlock> {
    return this.blocks.read(ref);
  }

  /**
   * Stop taking the store's session: write what is being filled and wait for every write. The
   * store keeps reading blocks back from the file.
   *
   * @param store The store recording, which stops recording.
   */
  async stop(store: TelemetryStore): Promise<void> {
    if (this.stopped) {
      return;
    }

    const finished = store.stopRecording();
    this.detach?.();
    this.detach = undefined;
    this.stopped = true;
    await finished;
    await this.flush();
    this.changed();
  }

  /** Wait until every record queued so far was written, or its write failed. */
  async flush(): Promise<void> {
    if (this.queue.length > 0) {
      this.draining ??= this.drain();
    }

    const draining = this.draining;

    if (draining) {
      await draining;
      return this.flush();
    }
  }

  private enqueue(record: RecordingRecord, block?: Pending['block']): Promise<void> {
    const bytes = encodeRecordingRecord(record);
    return new Promise<void>((resolve, reject) => {
      this.queue.push({ bytes, block, resolve, reject });
      this.draining ??= this.drain();
    });
  }

  private async drain(): Promise<void> {
    const batch = this.queue;
    this.queue = [];
    const written = await this.writeBatch(batch);

    if (written && this.queue.length > 0) {
      return this.drain();
    }

    this.draining = undefined;
  }

  private async writeBatch(batch: readonly Pending[]): Promise<boolean> {
    const size = batch.reduce((sum, item) => sum + item.bytes.byteLength, 0);
    const bytes = new Uint8Array(size);
    let at = 0;

    for (const item of batch) {
      bytes.set(item.bytes, at);
      at += item.bytes.byteLength;
    }

    try {
      await this.file.write(this.committed, bytes);
    } catch (error) {
      this.queue = [...batch.filter((item) => !item.block), ...this.queue];
      batch.filter((item) => item.block).forEach((item) => item.reject(error));
      this.failing = true;
      this.onError(error);
      this.changed();
      return false;
    }

    let offset = this.committed;

    for (const item of batch) {
      if (item.block) {
        this.blocks.place(item.block.ref, {
          offset: offset + RECORD_OVERHEAD,
          size: item.bytes.byteLength - RECORD_OVERHEAD,
        });
        this.writtenBlocks++;
        this.writtenSamples += item.block.length;
      }

      offset += item.bytes.byteLength;
      item.resolve();
    }

    this.committed = offset;
    this.failing = false;
    this.changed();
    return true;
  }

  private stats(): RecorderStats {
    return {
      bytes: this.committed,
      blocks: this.writtenBlocks,
      samples: this.writtenSamples,
      failing: this.failing,
      stopped: this.stopped,
    };
  }

  private changed(): void {
    this.snapshot = this.stats();
    [...this.listeners].forEach((listener) => listener());
  }
}
