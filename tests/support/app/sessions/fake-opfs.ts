/**
 * An Origin Private File System in memory, for tests of the storage worker: directories, files
 * and synchronous access handles that lock their file as Chromium's do.
 *
 * @module
 */

import {
  OpfsHost,
  type HostValue,
  type OpfsDirectory,
  type OpfsFile,
  type SyncAccessHandle,
} from '@/app/sessions/opfs-host';
import type { HostCall, HostTransport } from '@/app/sessions/opfs-library';

/** A file of the fake file system. */
export class FakeFile implements OpfsFile {
  readonly kind = 'file';
  bytes = new Uint8Array(0);
  locked = false;
  /** How many bytes the disk takes before writes come up short, as when the quota runs out. */
  room = Number.POSITIVE_INFINITY;

  createSyncAccessHandle(): Promise<SyncAccessHandle> {
    if (this.locked) {
      return Promise.reject(
        new DOMException('Access handles cannot be created', 'NoModificationAllowedError')
      );
    }

    this.locked = true;
    return Promise.resolve(new FakeHandle(this));
  }
}

class FakeHandle implements SyncAccessHandle {
  #open = true;

  constructor(private readonly file: FakeFile) {}

  read(buffer: Uint8Array, { at }: { readonly at: number }): number {
    this.#check();
    const available = this.file.bytes.subarray(at, at + buffer.byteLength);
    buffer.set(available);
    return available.byteLength;
  }

  write(buffer: Uint8Array, { at }: { readonly at: number }): number {
    this.#check();
    const count = Math.max(0, Math.min(buffer.byteLength, this.file.room));
    this.file.room -= count;
    const end = at + count;

    if (end > this.file.bytes.byteLength) {
      const grown = new Uint8Array(end);
      grown.set(this.file.bytes);
      this.file.bytes = grown;
    }

    this.file.bytes.set(buffer.subarray(0, count), at);
    return count;
  }

  truncate(size: number): void {
    this.#check();
    const bytes = new Uint8Array(size);
    bytes.set(this.file.bytes.subarray(0, size));
    this.file.bytes = bytes;
  }

  getSize(): number {
    this.#check();
    return this.file.bytes.byteLength;
  }

  flush(): void {
    this.#check();
  }

  close(): void {
    this.#open = false;
    this.file.locked = false;
  }

  #check(): void {
    if (!this.#open) {
      throw new DOMException('The access handle was closed', 'InvalidStateError');
    }
  }
}

/** A directory of the fake file system. */
export class FakeDirectory implements OpfsDirectory {
  readonly entries = new Map<string, FakeDirectory | FakeFile>();

  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<FakeDirectory> {
    const entry = this.entries.get(name);

    if (entry instanceof FakeDirectory) {
      return Promise.resolve(entry);
    }

    if (entry || !options?.create) {
      return Promise.reject(new DOMException(`No directory ${name}`, 'NotFoundError'));
    }

    const created = new FakeDirectory();
    this.entries.set(name, created);
    return Promise.resolve(created);
  }

  getFileHandle(name: string, options?: { create?: boolean }): Promise<FakeFile> {
    const entry = this.entries.get(name);

    if (entry instanceof FakeFile) {
      return Promise.resolve(entry);
    }

    if (entry || !options?.create) {
      return Promise.reject(new DOMException(`No file ${name}`, 'NotFoundError'));
    }

    const created = new FakeFile();
    this.entries.set(name, created);
    return Promise.resolve(created);
  }

  removeEntry(name: string, options?: { recursive?: boolean }): Promise<void> {
    const entry = this.entries.get(name);

    if (!entry) {
      return Promise.reject(new DOMException(`No entry ${name}`, 'NotFoundError'));
    }

    if (entry instanceof FakeDirectory && entry.entries.size > 0 && !options?.recursive) {
      return Promise.reject(new DOMException(`${name} is not empty`, 'InvalidModificationError'));
    }

    this.entries.delete(name);
    return Promise.resolve();
  }

  async *keys(): AsyncIterable<string> {
    yield* this.entries.keys();
  }

  /** The entry at a path of names, for tests. */
  at(...path: string[]): FakeDirectory | FakeFile | undefined {
    return path.reduce<FakeDirectory | FakeFile | undefined>(
      (entry, name) => (entry instanceof FakeDirectory ? entry.entries.get(name) : undefined),
      this
    );
  }
}

/**
 * A transport to a host over a fake file system, cloning each request and answer as
 * `postMessage` would. {@link crash} drops the host as a killed tab does, locks and all, while
 * the file system stays.
 */
export class DirectTransport implements HostTransport {
  #host: OpfsHost;
  generation = 0;

  constructor(readonly root: FakeDirectory) {
    this.#host = new OpfsHost(() => Promise.resolve(root));
  }

  async call(request: HostCall): Promise<HostValue> {
    const response = await this.#host.handle(structuredClone({ ...request, id: 0 }));

    if (!response.ok) {
      const error = new Error(response.error.message);
      error.name = response.error.name;
      throw error;
    }

    return structuredClone(response.value);
  }

  /** Lose every open handle without closing it, and start a new host. */
  crash(): void {
    unlockAll(this.root);
    this.generation++;
    this.#host = new OpfsHost(() => Promise.resolve(this.root));
  }
}

function unlockAll(directory: FakeDirectory): void {
  for (const entry of directory.entries.values()) {
    if (entry instanceof FakeDirectory) {
      unlockAll(entry);
    } else {
      entry.locked = false;
    }
  }
}
