import { Emitter, type Unsubscribe } from '@/core/emitter';
import type { BlockBacking, BlockRef, BlockData } from '@/history/block-backing';
import type { HistoryStore } from '@/history/history-store';
import type { RecordingRecord } from '@/history/types';

import { encodeRecordingHeader, type RecordingHeader } from './codec';
import type { RecordingFile } from './recording-file';
import { RecordingBlocks } from './recording-reader';
import { encodeRecordingRecord, RECORD_OVERHEAD } from './scan';

/**
 * How far a recorder got, for the recording indicator.
 */
export interface RecordingWriterStats {
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
 * Writes a store's session to a recording file as it grows: the header, then what the store
 * already holds, then every block and ingestion event as they come. It is the store's persistence
 * layer while recording, so blocks written can leave memory and come back from the file.
 *
 * Writes go one at a time, each batching whatever queued up behind the previous one. A write
 * that fails is reported and not lost: its events are written again with the next write, and the
 * store writes its blocks again after a backoff. Records go at the end of what is known to be in
 * the file, so a write cut short is overwritten by the next one.
 */
export class RecordingWriter implements BlockBacking {
  readonly #file: RecordingFile;
  readonly #onError: (error: unknown) => void;
  readonly #blocks: RecordingBlocks;
  readonly #changes = new Emitter<{ change: undefined }>();
  #queue: Pending[] = [];
  #draining: Promise<void> | undefined;
  #committed: number;
  #writtenBlocks = 0;
  #writtenSamples = 0;
  #failing = false;
  #stopped = false;
  #detach: Unsubscribe | undefined;
  #status: RecordingWriterStats;

  private constructor(file: RecordingFile, headerBytes: number, onError: (error: unknown) => void) {
    this.#file = file;
    this.#onError = onError;
    this.#blocks = new RecordingBlocks(file);
    this.#committed = headerBytes;
    this.#status = this.#stats();
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
    store: HistoryStore,
    onError: (error: unknown) => void = () => undefined
  ): Promise<RecordingWriter> {
    const head = encodeRecordingHeader(header);
    await file.truncate(0);
    await file.write(0, head);
    const recorder = new RecordingWriter(file, head.byteLength, onError);
    recorder.#detach = store.follow(
      (record) => void recorder.#enqueue(record).catch(() => undefined)
    );
    store.startRecording(recorder);
    return recorder;
  }

  /** How far the recorder got; the same object until it changes. */
  get status(): RecordingWriterStats {
    return this.#status;
  }

  /** Hear about changes of {@link status}; returns the function that stops it. */
  subscribe(listener: () => void): Unsubscribe {
    return this.#changes.on('change', listener);
  }

  /** {@inheritDoc BlockBacking.write} */
  write(block: BlockData): Promise<void> {
    return this.#enqueue({ kind: 'block', block }, { ref: block.ref, length: block.time.length });
  }

  /** {@inheritDoc BlockBacking.read} */
  read(ref: BlockRef): Promise<BlockData> {
    return this.#blocks.read(ref);
  }

  /**
   * Stop taking the store's session: write what is being filled and wait for every write. The
   * store keeps reading blocks back from the file.
   *
   * @param store The store recording, which stops recording.
   */
  async stop(store: HistoryStore): Promise<void> {
    if (this.#stopped) {
      return;
    }

    const finished = store.stopRecording();
    this.#detach?.();
    this.#detach = undefined;
    this.#stopped = true;
    await finished;
    await this.flush();
    this.#changed();
  }

  /** Wait until every record queued so far was written, or its write failed. */
  async flush(): Promise<void> {
    if (this.#queue.length > 0) {
      this.#draining ??= this.#drain();
    }

    const draining = this.#draining;

    if (draining) {
      await draining;
      return this.flush();
    }
  }

  #enqueue(record: RecordingRecord, block?: Pending['block']): Promise<void> {
    const bytes = encodeRecordingRecord(record);
    return new Promise<void>((resolve, reject) => {
      this.#queue.push({ bytes, block, resolve, reject });
      this.#draining ??= this.#drain();
    });
  }

  async #drain(): Promise<void> {
    const batch = this.#queue;
    this.#queue = [];
    const written = await this.#writeBatch(batch);

    if (written && this.#queue.length > 0) {
      return this.#drain();
    }

    this.#draining = undefined;
  }

  async #writeBatch(batch: readonly Pending[]): Promise<boolean> {
    const size = batch.reduce((sum, item) => sum + item.bytes.byteLength, 0);
    const bytes = new Uint8Array(size);
    let at = 0;

    for (const item of batch) {
      bytes.set(item.bytes, at);
      at += item.bytes.byteLength;
    }

    try {
      await this.#file.write(this.#committed, bytes);
    } catch (error) {
      this.#queue = [...batch.filter((item) => !item.block), ...this.#queue];
      batch.filter((item) => item.block).forEach((item) => item.reject(error));
      this.#failing = true;
      this.#onError(error);
      this.#changed();
      return false;
    }

    let offset = this.#committed;

    for (const item of batch) {
      if (item.block) {
        this.#blocks.place(item.block.ref, {
          offset: offset + RECORD_OVERHEAD,
          size: item.bytes.byteLength - RECORD_OVERHEAD,
        });
        this.#writtenBlocks++;
        this.#writtenSamples += item.block.length;
      }

      offset += item.bytes.byteLength;
      item.resolve();
    }

    this.#committed = offset;
    this.#failing = false;
    this.#changed();
    return true;
  }

  #stats(): RecordingWriterStats {
    return {
      bytes: this.#committed,
      blocks: this.#writtenBlocks,
      samples: this.#writtenSamples,
      failing: this.#failing,
      stopped: this.#stopped,
    };
  }

  #changed(): void {
    this.#status = this.#stats();
    this.#changes.emit('change', undefined);
  }
}
