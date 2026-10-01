/**
 * A session library in memory, for tests and for browsers without the Origin Private File
 * System: sessions last as long as the tab.
 *
 * @module
 */

import { MemoryRecordingFile, type RecordingFile } from '@/recording';

import {
  byNewest,
  type SessionInfo,
  type SessionLibrary,
  type SessionUpdate,
  type StorageEstimate,
} from './session-library';

interface Entry {
  info: SessionInfo;
  readonly file: MemoryRecordingFile;
  opened: number;
}

/** A {@link RecordingFile} that shares one file among openings, each closed on its own. */
class SharedFile implements RecordingFile {
  #closed = false;

  constructor(
    private readonly entry: Entry,
    private readonly target: MemoryRecordingFile
  ) {
    entry.opened++;
  }

  size(): Promise<number> {
    return this.target.size();
  }

  read(offset: number, length: number): Promise<Uint8Array> {
    return this.target.read(offset, length);
  }

  write(offset: number, bytes: Uint8Array): Promise<void> {
    return this.target.write(offset, bytes);
  }

  truncate(size: number): Promise<void> {
    return this.target.truncate(size);
  }

  close(): Promise<void> {
    if (!this.#closed) {
      this.#closed = true;
      this.entry.opened--;
    }

    return Promise.resolve();
  }
}

/** Sessions kept in memory. */
export class MemorySessionLibrary implements SessionLibrary {
  readonly kind = 'memory';
  readonly #entries = new Map<string, Entry>();
  readonly #now: () => number;

  /**
   * @param now Wall time in milliseconds.
   */
  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  /** The bytes of a session's file, for tests. */
  contents(id: string): Uint8Array {
    return this.#entries.get(id)?.file.contents() ?? new Uint8Array(0);
  }

  /** How many openings of a session's file are not closed, for tests. */
  openings(id: string): number {
    return this.#entries.get(id)?.opened ?? 0;
  }

  /** Put a session in as a tab that died would have left it, for tests. */
  seed(info: SessionInfo, bytes: Uint8Array): void {
    this.#entries.set(info.id, { info, file: new MemoryRecordingFile(bytes), opened: 0 });
  }

  list(): Promise<SessionInfo[]> {
    return Promise.resolve(
      [...this.#entries.values()].map((entry) => entry.info).toSorted(byNewest)
    );
  }

  create(info: Omit<SessionInfo, 'updatedAtMs'>) {
    const entry: Entry = {
      info: { ...info, updatedAtMs: this.#now() },
      file: new MemoryRecordingFile(),
      opened: 0,
    };
    this.#entries.set(info.id, entry);
    return Promise.resolve({ info: entry.info, file: new SharedFile(entry, entry.file) });
  }

  async open(id: string): Promise<RecordingFile> {
    const entry = await this.#entry(id);
    return new SharedFile(entry, entry.file);
  }

  async update(id: string, update: SessionUpdate): Promise<SessionInfo> {
    const entry = await this.#entry(id);
    entry.info = { ...entry.info, ...update, updatedAtMs: this.#now() };
    return entry.info;
  }

  async remove(id: string): Promise<void> {
    if ((await this.#entry(id)).opened > 0) {
      throw new Error(`Session ${id} is open`);
    }

    this.#entries.delete(id);
  }

  estimate(): Promise<StorageEstimate | null> {
    return Promise.resolve(null);
  }

  persist(): Promise<boolean> {
    return Promise.resolve(false);
  }

  #entry(id: string): Promise<Entry> {
    const entry = this.#entries.get(id);
    return entry ? Promise.resolve(entry) : Promise.reject(new Error(`No session ${id}`));
  }
}
