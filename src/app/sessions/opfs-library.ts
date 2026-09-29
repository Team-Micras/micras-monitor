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
  /**
   * Grows each time the host behind the transport starts over, as when its worker died, so that
   * handles of files opened before can be told stale.
   */
  readonly generation: number;

  /** Send a request; `transfer` lists buffers to move rather than copy. */
  call(request: HostCall, transfer?: Transferable[]): Promise<HostValue>;
}

/** The part of a `Worker`, or a `MessagePort`, the transport uses. */
export interface MessageTarget {
  postMessage(message: unknown, transfer: Transferable[]): void;
  addEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void;
  addEventListener(type: 'error', listener: (event: Event) => void): void;
  /** Stops the worker; a message port has no such thing. */
  terminate?(): void;
}

/** How long a request may go unanswered before the worker is taken for dead: 30 s. */
export const DEFAULT_CALL_TIMEOUT_MS = 30_000;

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

interface Pending {
  readonly resolve: (value: HostValue) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

/**
 * A transport over `postMessage` to a worker it starts. A worker that reports an error, as when
 * its script cannot load, or leaves a request unanswered past the timeout, as when it hangs or
 * was killed without a word, is taken for dead: every request waiting on it fails, it is stopped,
 * and the next request starts a new one.
 */
export class MessageTransport implements HostTransport {
  readonly #start: () => MessageTarget;
  readonly #timeoutMs: number;
  readonly #pending = new Map<number, Pending>();
  #target: MessageTarget | undefined;
  #generation = 0;
  #nextId = 1;

  /**
   * @param start Starts a worker, or gives a port; called again after one is taken for dead.
   * @param timeoutMs How long a request may go unanswered.
   */
  constructor(start: () => MessageTarget, timeoutMs = DEFAULT_CALL_TIMEOUT_MS) {
    this.#start = start;
    this.#timeoutMs = timeoutMs;
  }

  /** {@inheritDoc HostTransport.generation} */
  get generation(): number {
    return this.#generation;
  }

  call(request: HostCall, transfer: Transferable[] = []): Promise<HostValue> {
    const target = this.#connect();
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#die(target, 'TimeoutError', `The storage worker did not answer ${request.op}`);
      }, this.#timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });

      try {
        target.postMessage({ ...request, id }, transfer);
      } catch (error) {
        this.#settle(id);
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  #connect(): MessageTarget {
    if (this.#target) {
      return this.#target;
    }

    const target = this.#start();
    this.#target = target;
    target.addEventListener('message', (event) => this.#receive(target, event.data));
    target.addEventListener('error', () =>
      this.#die(target, 'AbortError', 'The storage worker stopped')
    );
    return target;
  }

  #receive(target: MessageTarget, data: unknown): void {
    if (target !== this.#target || !isResponse(data)) {
      return;
    }

    const pending = this.#settle(data.id);

    if (data.ok) {
      pending?.resolve(data.value);
    } else {
      pending?.reject(new StorageError(data.error.name, data.error.message));
    }
  }

  #settle(id: number): Pending | undefined {
    const pending = this.#pending.get(id);
    this.#pending.delete(id);

    if (pending) {
      clearTimeout(pending.timer);
    }

    return pending;
  }

  #die(target: MessageTarget, name: string, message: string): void {
    if (target !== this.#target) {
      return;
    }

    this.#target = undefined;
    this.#generation++;
    target.terminate?.();
    const pending = [...this.#pending.values()];
    this.#pending.clear();
    pending.forEach(({ reject, timer }) => {
      clearTimeout(timer);
      reject(new StorageError(name, message));
    });
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

/**
 * A recording file the worker holds open. After the worker started over, the next access opens
 * the file again in the new one, so a recording carries on at the position it had.
 */
class WorkerFile implements RecordingFile {
  #closed = false;
  #handle: number;
  #generation: number;
  #reopening: Promise<void> | undefined;

  constructor(
    private readonly transport: HostTransport,
    private readonly session: string,
    handle: number
  ) {
    this.#handle = handle;
    this.#generation = transport.generation;
  }

  async size(): Promise<number> {
    return expectNumber(await this.transport.call({ op: 'size', handle: await this.#current() }));
  }

  async read(offset: number, length: number): Promise<Uint8Array> {
    const handle = await this.#current();
    return expectBytes(await this.transport.call({ op: 'read', handle, offset, length }));
  }

  async write(offset: number, bytes: Uint8Array): Promise<void> {
    const handle = await this.#current();
    await this.transport.call({ op: 'write', handle, offset, bytes });
  }

  async truncate(size: number): Promise<void> {
    const handle = await this.#current();
    await this.transport.call({ op: 'truncate', handle, size });
  }

  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }

    this.#closed = true;

    if (this.#generation === this.transport.generation) {
      await this.transport.call({ op: 'close', handle: this.#handle });
    }
  }

  async #current(): Promise<number> {
    if (this.#closed) {
      throw new StorageError('InvalidStateError', 'The recording file is closed');
    }

    if (this.#generation !== this.transport.generation) {
      this.#reopening ??= this.#reopen().finally(() => {
        this.#reopening = undefined;
      });
      await this.#reopening;
    }

    return this.#handle;
  }

  async #reopen(): Promise<void> {
    const generation = this.transport.generation;
    this.#handle = expectNumber(await this.transport.call({ op: 'open', session: this.session }));
    this.#generation = generation;
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

  async create(info: Omit<SessionInfo, 'updatedAtMs'>) {
    const created = expectInfo(
      await this.#transport.call({ op: 'create', info, nowMs: this.#now() })
    );
    return { info: created, file: await this.open(created.id) };
  }

  async open(id: string): Promise<RecordingFile> {
    const handle = expectNumber(await this.#transport.call({ op: 'open', session: id }));
    return new WorkerFile(this.#transport, id, handle);
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
