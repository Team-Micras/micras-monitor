/**
 * The saved sessions in the Origin Private File System, as a dedicated worker serves them: only
 * a worker gets synchronous access handles, the one way to append to a file durably without
 * copying it on every write.
 *
 * Layout, under the origin's root:
 *
 * ```
 * micras-monitor/sessions/<id>/session.json    the RecordingInfo, rewritten whole
 * micras-monitor/sessions/<id>/session.next.json the same, written first on every change
 * micras-monitor/sessions/<id>/recording.mmrec the recording, in the current format version
 * ```
 *
 * A description is written to `session.next.json` and then to `session.json`, so a tab that dies
 * during a write leaves one of them whole; the reader takes `session.json`, else the other. A
 * session with neither, as when the tab died before the first one was written, is listed, and
 * updated, from its directory's name as a recording cut short, so that it is recovered.
 *
 * @module
 */

import {
  byNewest,
  isRecordingInfo,
  type RecordingInfo,
  type RecordingUpdate,
} from './recording-library';

/** A synchronous access handle, as `FileSystemSyncAccessHandle` has it in a worker. */
export interface SyncAccessHandle {
  read(buffer: Uint8Array, options: { readonly at: number }): number;
  write(buffer: Uint8Array, options: { readonly at: number }): number;
  truncate(size: number): void;
  getSize(): number;
  flush(): void;
  close(): void;
}

/** A file of the Origin Private File System, as the host uses it. */
export interface OpfsFile {
  readonly kind: 'file';
}

/** A directory of the Origin Private File System, as the host uses it. */
export interface OpfsDirectory {
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<OpfsDirectory>;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<OpfsFile>;
  removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>;
  keys(): AsyncIterable<string>;
}

interface SyncCapable {
  createSyncAccessHandle(): Promise<SyncAccessHandle>;
}

/** A request to the host. Every one carries an id its response repeats. */
export type HostRequest =
  | { readonly id: number; readonly op: 'list' }
  | {
      readonly id: number;
      readonly op: 'create';
      readonly info: Omit<RecordingInfo, 'updatedAtMs'>;
      readonly nowMs: number;
    }
  | {
      readonly id: number;
      readonly op: 'update';
      readonly session: string;
      readonly update: RecordingUpdate;
      readonly nowMs: number;
    }
  | { readonly id: number; readonly op: 'remove'; readonly session: string }
  | { readonly id: number; readonly op: 'open'; readonly session: string }
  | { readonly id: number; readonly op: 'size'; readonly handle: number }
  | {
      readonly id: number;
      readonly op: 'read';
      readonly handle: number;
      readonly offset: number;
      readonly length: number;
    }
  | {
      readonly id: number;
      readonly op: 'write';
      readonly handle: number;
      readonly offset: number;
      readonly bytes: Uint8Array;
    }
  | { readonly id: number; readonly op: 'truncate'; readonly handle: number; readonly size: number }
  | { readonly id: number; readonly op: 'close'; readonly handle: number };

/** What a request returns. */
export type HostValue = RecordingInfo[] | RecordingInfo | number | Uint8Array | null;

/** The host's answer to a request. */
export type HostResponse =
  | { readonly id: number; readonly ok: true; readonly value: HostValue }
  | {
      readonly id: number;
      readonly ok: false;
      readonly error: { readonly name: string; readonly message: string };
    };

const OPERATIONS: ReadonlySet<unknown> = new Set<HostRequest['op']>([
  'list',
  'create',
  'update',
  'remove',
  'open',
  'size',
  'read',
  'write',
  'truncate',
  'close',
]);

/** Whether a message is a request to the host, by its id and operation. */
export function isHostRequest(value: unknown): value is HostRequest {
  return (
    typeof value === 'object' &&
    value !== null &&
    'id' in value &&
    typeof value.id === 'number' &&
    'op' in value &&
    OPERATIONS.has(value.op)
  );
}

const APP_DIRECTORY = 'micras-monitor';
const SESSIONS_DIRECTORY = 'sessions';
const INFO_FILE = 'session.json';
const NEXT_INFO_FILE = 'session.next.json';
const RECORDING_FILE = 'recording.mmrec';

interface OpenFile {
  readonly handle: SyncAccessHandle;
  openings: number;
}

function hasSyncAccess(file: OpfsFile): file is OpfsFile & SyncCapable {
  return 'createSyncAccessHandle' in file && typeof file.createSyncAccessHandle === 'function';
}

function startOf(id: string): number {
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\d{3})/.exec(id);

  if (!match) {
    return 0;
  }

  const [year, month, day, hour, minute, second, ms] = match.slice(1).map(Number);
  return Date.UTC(year, month - 1, day, hour, minute, second, ms);
}

function failure(error: unknown): { name: string; message: string } {
  if (error instanceof Error) {
    return { name: error.name, message: error.message };
  }

  return { name: 'Error', message: String(error) };
}

async function syncHandle(file: OpfsFile): Promise<SyncAccessHandle> {
  if (!hasSyncAccess(file)) {
    throw new Error('This browser cannot write files from a worker');
  }

  return file.createSyncAccessHandle();
}

/**
 * Serves the session library and its recording files over the Origin Private File System. It
 * handles one request at a time, in the order they come, so a write never races a read of the
 * same file.
 */
export class OpfsHost {
  readonly #root: () => Promise<OpfsDirectory>;
  readonly #files = new Map<string, OpenFile>();
  readonly #handles = new Map<number, string>();
  #sessions: Promise<OpfsDirectory> | undefined;
  #nextHandle = 1;
  #queue: Promise<unknown> = Promise.resolve();

  /**
   * @param root The origin's root directory: `navigator.storage.getDirectory` in the worker.
   */
  constructor(root: () => Promise<OpfsDirectory>) {
    this.#root = root;
  }

  /** Answer a request once the ones before it are answered. */
  handle(request: HostRequest): Promise<HostResponse> {
    const answer = this.#queue.then(() => this.#answer(request));
    this.#queue = answer;
    return answer;
  }

  async #answer(request: HostRequest): Promise<HostResponse> {
    try {
      return { id: request.id, ok: true, value: await this.#run(request) };
    } catch (error) {
      return { id: request.id, ok: false, error: failure(error) };
    }
  }

  async #run(request: HostRequest): Promise<HostValue> {
    switch (request.op) {
      case 'list':
        return this.#list();
      case 'create':
        return this.#create(request.info, request.nowMs);
      case 'update':
        return this.#update(request.session, request.update, request.nowMs);
      case 'remove':
        return this.#remove(request.session);
      case 'open':
        return this.#open(request.session);
      default:
        return this.#file(request);
    }
  }

  #file(request: Extract<HostRequest, { handle: number }>): HostValue {
    const path = this.#handles.get(request.handle);
    const open = path === undefined ? undefined : this.#files.get(path);

    if (path === undefined || !open) {
      throw new Error(`File handle ${request.handle} is not open`);
    }

    const { handle } = open;

    switch (request.op) {
      case 'size':
        return handle.getSize();
      case 'read': {
        const size = handle.getSize();

        if (request.offset < 0 || request.offset + request.length > size) {
          throw new RangeError(
            `Cannot read ${request.length} bytes at ${request.offset} of ${size}`
          );
        }

        const bytes = new Uint8Array(request.length);
        handle.read(bytes, { at: request.offset });
        return bytes;
      }
      case 'write': {
        const written = handle.write(request.bytes, { at: request.offset });

        if (written !== request.bytes.byteLength) {
          throw new DOMException(
            `Wrote ${written} of ${request.bytes.byteLength} bytes`,
            'QuotaExceededError'
          );
        }

        handle.flush();
        return null;
      }
      case 'truncate':
        handle.truncate(request.size);
        handle.flush();
        return null;
      default:
        this.#handles.delete(request.handle);
        open.openings--;

        if (open.openings === 0) {
          handle.close();
          this.#files.delete(path);
        }

        return null;
    }
  }

  #directory(): Promise<OpfsDirectory> {
    this.#sessions ??= this.#root()
      .then((root) => root.getDirectoryHandle(APP_DIRECTORY, { create: true }))
      .then((app) => app.getDirectoryHandle(SESSIONS_DIRECTORY, { create: true }));
    this.#sessions.catch(() => {
      this.#sessions = undefined;
    });
    return this.#sessions;
  }

  async #list(): Promise<RecordingInfo[]> {
    const sessions = await this.#directory();
    const names: string[] = [];

    for await (const name of sessions.keys()) {
      names.push(name);
    }

    const infos = await Promise.all(
      names.map((name) => this.#readInfo(name).catch(() => this.#stray(name)))
    );
    return infos.filter((info): info is RecordingInfo => info !== null).toSorted(byNewest);
  }

  async #create(info: Omit<RecordingInfo, 'updatedAtMs'>, nowMs: number) {
    const sessions = await this.#directory();
    const folder = await sessions.getDirectoryHandle(info.id, { create: true });
    await folder.getFileHandle(RECORDING_FILE, { create: true });
    const created: RecordingInfo = { ...info, updatedAtMs: nowMs };
    await this.#writeInfo(created);
    return created;
  }

  async #update(id: string, update: RecordingUpdate, nowMs: number): Promise<RecordingInfo> {
    const current = await this.#readInfo(id).catch(() => this.#stray(id));

    if (current === null) {
      throw new Error(`No session ${id}`);
    }

    const next: RecordingInfo = { ...current, ...update, updatedAtMs: nowMs };
    await this.#writeInfo(next);
    return next;
  }

  async #remove(id: string): Promise<null> {
    if (this.#files.has(id)) {
      throw new Error(`Session ${id} is open`);
    }

    const sessions = await this.#directory();
    await sessions.removeEntry(id, { recursive: true });
    return null;
  }

  async #open(id: string): Promise<number> {
    let open = this.#files.get(id);

    if (!open) {
      const sessions = await this.#directory();
      const folder = await sessions.getDirectoryHandle(id);
      const handle = await syncHandle(await folder.getFileHandle(RECORDING_FILE));
      open = { handle, openings: 0 };
      this.#files.set(id, open);
    }

    open.openings++;
    const handle = this.#nextHandle++;
    this.#handles.set(handle, id);
    return handle;
  }

  async #readInfo(id: string): Promise<RecordingInfo> {
    return this.#readInfoFrom(id, INFO_FILE).catch(() => this.#readInfoFrom(id, NEXT_INFO_FILE));
  }

  async #readInfoFrom(id: string, name: string): Promise<RecordingInfo> {
    const sessions = await this.#directory();
    const folder = await sessions.getDirectoryHandle(id);
    const handle = await syncHandle(await folder.getFileHandle(name));

    try {
      const bytes = new Uint8Array(handle.getSize());
      handle.read(bytes, { at: 0 });
      const value: unknown = JSON.parse(new TextDecoder().decode(bytes));

      if (!isRecordingInfo(value) || value.id !== id) {
        throw new Error(`Session ${id} has no readable description`);
      }

      return value;
    } finally {
      handle.close();
    }
  }

  async #stray(id: string): Promise<RecordingInfo | null> {
    try {
      const sessions = await this.#directory();
      const folder = await sessions.getDirectoryHandle(id);
      await folder.getFileHandle(RECORDING_FILE);
    } catch {
      return null;
    }

    const createdAtMs = startOf(id);
    return {
      id,
      name: id,
      robot: null,
      createdAtMs,
      updatedAtMs: createdAtMs,
      state: 'recording',
      bytes: 0,
      samples: 0,
      durationUs: 0,
    };
  }

  async #writeInfo(info: RecordingInfo): Promise<void> {
    await this.#writeInfoTo(info, NEXT_INFO_FILE);
    await this.#writeInfoTo(info, INFO_FILE);
  }

  async #writeInfoTo(info: RecordingInfo, name: string): Promise<void> {
    const sessions = await this.#directory();
    const folder = await sessions.getDirectoryHandle(info.id);
    const handle = await syncHandle(await folder.getFileHandle(name, { create: true }));

    try {
      const bytes = new TextEncoder().encode(JSON.stringify(info));
      handle.write(bytes, { at: 0 });
      handle.truncate(bytes.byteLength);
      handle.flush();
    } finally {
      handle.close();
    }
  }
}
