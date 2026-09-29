/**
 * The session library over the Origin Private File System, as the page sees it: every file
 * operation goes to the dedicated worker that holds the synchronous access handles.
 *
 * @module
 */

import type { RecordingFile } from '@/telemetry';

import type { HostRequest, HostResponse, HostValue } from './opfs-host';
import type {
  SessionInfo,
  SessionLibrary,
  SessionUpdate,
  StorageEstimate,
} from './session-library';

/** A request without its id, which the transport adds. */
export type HostCall = HostRequest extends infer Request
  ? Request extends { readonly id: number }
    ? Omit<Request, 'id'>
    : never
  : never;

/** Carries requests to the host and brings back its answers. */
export interface HostTransport {
  /** Send a request; `transfer` lists buffers to move rather than copy. */
  call(request: HostCall, transfer?: Transferable[]): Promise<HostValue>;
}

/** The part of a `Worker`, or a `MessagePort`, the transport uses. */
export interface MessageTarget {
  postMessage(message: unknown, transfer: Transferable[]): void;
  addEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void;
  addEventListener(type: 'error', listener: (event: Event) => void): void;
}

function isResponse(value: unknown): value is HostResponse {
  return typeof value === 'object' && value !== null && 'id' in value && 'ok' in value;
}

/** The error a failed request is rethrown as, keeping the name, such as `QuotaExceededError`. */
export class StorageError extends Error {
  constructor(name: string, message: string) {
    super(message);
    this.name = name;
  }
}

/** A transport over `postMessage`, to a worker or a message port. */
export class MessageTransport implements HostTransport {
  readonly #target: MessageTarget;
  readonly #pending = new Map<
    number,
    { readonly resolve: (value: HostValue) => void; readonly reject: (error: Error) => void }
  >();
  #nextId = 1;

  constructor(target: MessageTarget) {
    this.#target = target;
    target.addEventListener('message', (event) => this.#receive(event.data));
    target.addEventListener('error', () => this.#failAll('The storage worker stopped'));
  }

  call(request: HostCall, transfer: Transferable[] = []): Promise<HostValue> {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#target.postMessage({ ...request, id }, transfer);
    });
  }

  #receive(data: unknown): void {
    if (!isResponse(data)) {
      return;
    }

    const pending = this.#pending.get(data.id);
    this.#pending.delete(data.id);

    if (data.ok) {
      pending?.resolve(data.value);
    } else {
      pending?.reject(new StorageError(data.error.name, data.error.message));
    }
  }

  #failAll(message: string): void {
    const pending = [...this.#pending.values()];
    this.#pending.clear();
    pending.forEach(({ reject }) => reject(new StorageError('AbortError', message)));
  }
}

function expectNumber(value: HostValue): number {
  if (typeof value !== 'number') {
    throw new TypeError('The storage worker answered something other than a number');
  }

  return value;
}

function expectBytes(value: HostValue): Uint8Array {
  if (!(value instanceof Uint8Array)) {
    throw new TypeError('The storage worker answered something other than bytes');
  }

  return value;
}

function expectInfo(value: HostValue): SessionInfo {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    value instanceof Uint8Array
  ) {
    throw new TypeError('The storage worker answered something other than a session');
  }

  return value;
}

function expectList(value: HostValue): SessionInfo[] {
  if (!Array.isArray(value)) {
    throw new TypeError('The storage worker answered something other than a list');
  }

  return value;
}

/** A recording file the worker holds open. */
class WorkerFile implements RecordingFile {
  #closed = false;

  constructor(
    private readonly transport: HostTransport,
    private readonly handle: number
  ) {}

  async size(): Promise<number> {
    return expectNumber(await this.transport.call({ op: 'size', handle: this.handle }));
  }

  async read(offset: number, length: number): Promise<Uint8Array> {
    return expectBytes(
      await this.transport.call({ op: 'read', handle: this.handle, offset, length })
    );
  }

  async write(offset: number, bytes: Uint8Array): Promise<void> {
    await this.transport.call({ op: 'write', handle: this.handle, offset, bytes });
  }

  async truncate(size: number): Promise<void> {
    await this.transport.call({ op: 'truncate', handle: this.handle, size });
  }

  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }

    this.#closed = true;
    await this.transport.call({ op: 'close', handle: this.handle });
  }
}

/** The parts of `navigator.storage` the library asks about quota and persistence. */
export interface StorageManagerLike {
  estimate(): Promise<{ readonly usage?: number; readonly quota?: number }>;
  persist(): Promise<boolean>;
  persisted(): Promise<boolean>;
}

/** Saved sessions in the Origin Private File System. */
export class OpfsSessionLibrary implements SessionLibrary {
  readonly kind = 'opfs';
  readonly #transport: HostTransport;
  readonly #storage: StorageManagerLike | undefined;
  readonly #now: () => number;

  /**
   * @param transport Reaches the worker's {@link OpfsHost}.
   * @param storage `navigator.storage`, for quota and persistence.
   * @param now Wall time in milliseconds.
   */
  constructor(
    transport: HostTransport,
    storage?: StorageManagerLike,
    now: () => number = Date.now
  ) {
    this.#transport = transport;
    this.#storage = storage;
    this.#now = now;
  }

  async list(): Promise<SessionInfo[]> {
    return expectList(await this.#transport.call({ op: 'list' }));
  }

  async create(info: Omit<SessionInfo, 'id' | 'updatedAtMs'>) {
    const created = expectInfo(
      await this.#transport.call({ op: 'create', info, nowMs: this.#now() })
    );
    return { info: created, file: await this.open(created.id) };
  }

  async open(id: string): Promise<RecordingFile> {
    const handle = expectNumber(await this.#transport.call({ op: 'open', session: id }));
    return new WorkerFile(this.#transport, handle);
  }

  async update(id: string, update: SessionUpdate): Promise<SessionInfo> {
    return expectInfo(
      await this.#transport.call({ op: 'update', session: id, update, nowMs: this.#now() })
    );
  }

  async remove(id: string): Promise<void> {
    await this.#transport.call({ op: 'remove', session: id });
  }

  async estimate(): Promise<StorageEstimate | null> {
    if (!this.#storage) {
      return null;
    }

    const [{ usage = 0, quota = 0 }, persisted] = await Promise.all([
      this.#storage.estimate(),
      this.#storage.persisted(),
    ]);
    return { usage, quota, persisted };
  }

  async persist(): Promise<boolean> {
    return (await this.#storage?.persist()) ?? false;
  }
}
