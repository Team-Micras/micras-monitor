/**
 * Where saved sessions live: one recording file and a small description per session, and a lock
 * that tells a session another tab is recording from one whose tab died.
 *
 * @module
 */

import type { RecordingFile } from '..';

/** Whether a session is being recorded, or its recording ended. */
export type RecordingState = 'recording' | 'saved';

/** What recovering a recording cut short found. */
export interface RecordingRecovery {
  /** When it was recovered, in `Date.now()` milliseconds. */
  readonly recoveredAtMs: number;
  /** Bytes of the incomplete last record, cut from the file. */
  readonly truncatedBytes: number;
  /** Records skipped in the middle of the file because they were damaged. */
  readonly damagedRecords: number;
}

/** A saved session, as the sessions list shows it. */
export interface RecordingInfo {
  /** Unique in the library; also the session's directory. */
  readonly id: string;
  /** The name the user gave it, or the one it was made with. */
  readonly name: string;
  /** The robot it was recorded from, when it said its name. */
  readonly robot: string | null;
  /** When recording started, in `Date.now()` milliseconds. */
  readonly createdAtMs: number;
  /** When the description last changed. */
  readonly updatedAtMs: number;
  /**
   * `recording` while a tab records it; a session left `recording` that no tab holds the lock
   * of was cut short and is recovered on the next start.
   */
  readonly state: RecordingState;
  /** The size of its file, as of the last update. */
  readonly bytes: number;
  /** The samples of its blocks, as of the last update. */
  readonly samples: number;
  /** The span of its samples on the session timeline, as of the last update. */
  readonly durationUs: number;
  /** What its recovery found, if it was cut short. */
  readonly recovery?: RecordingRecovery;
}

/** The part of a session's description that can change after it is made. */
export type RecordingUpdate = Partial<
  Pick<
    RecordingInfo,
    'name' | 'robot' | 'createdAtMs' | 'state' | 'bytes' | 'samples' | 'durationUs' | 'recovery'
  >
>;

/** What the browser grants the monitor to store. */
export interface StorageEstimate {
  /** Bytes the origin uses. */
  readonly usage: number;
  /** Bytes it may use. */
  readonly quota: number;
  /** Whether the browser promised not to evict the origin's data under storage pressure. */
  readonly persisted: boolean;
}

/** Saved sessions, each a recording file and its description. */
export interface RecordingLibrary {
  /** Where the files are: the Origin Private File System, or memory when it is not available. */
  readonly kind: 'opfs' | 'memory';

  /** Every session, newest first. */
  list(): Promise<RecordingInfo[]>;

  /**
   * Make a session and its empty recording file, open for writing. The caller picks the id, with
   * {@link sessionId}, so that it can hold the session's lock before the session exists.
   *
   * @throws If there is no room, or the file system refuses.
   */
  create(
    info: Omit<RecordingInfo, 'updatedAtMs'>
  ): Promise<{ readonly info: RecordingInfo; readonly file: RecordingFile }>;

  /**
   * Open a session's recording file. Opening a file already open shares it; each opening is
   * closed on its own.
   */
  open(id: string): Promise<RecordingFile>;

  /** Change a session's description. */
  update(id: string, update: RecordingUpdate): Promise<RecordingInfo>;

  /** Delete a session and its file; its file must not be open. */
  remove(id: string): Promise<void>;

  /** How much the origin stores and may store, if the browser tells. */
  estimate(): Promise<StorageEstimate | null>;

  /** Ask the browser to keep the origin's data under storage pressure; whether it will. */
  persist(): Promise<boolean>;
}

/** Tells a session a live tab records from one left behind by a tab that died. */
export interface RecordingLocks {
  /**
   * Hold a session's lock until the returned function is called, or the tab dies.
   *
   * @returns The function that lets go of it.
   */
  hold(id: string): Promise<() => void>;

  /** Whether any tab holds a session's lock. */
  held(id: string): Promise<boolean>;

  /**
   * Run a task holding a session's lock, unless a tab already holds it.
   *
   * @returns What the task gave, or null when another tab held the lock and the task did not run.
   */
  runIfFree<T>(id: string, task: () => Promise<T>): Promise<{ readonly value: T } | null>;
}

/** Locks for one tab alone, for tests and for browsers without Web Locks. */
export class MemoryLocks implements RecordingLocks {
  readonly #held = new Set<string>();

  /** {@inheritDoc RecordingLocks.hold} */
  hold(id: string): Promise<() => void> {
    this.#held.add(id);
    return Promise.resolve(() => this.#held.delete(id));
  }

  /** {@inheritDoc RecordingLocks.held} */
  held(id: string): Promise<boolean> {
    return Promise.resolve(this.#held.has(id));
  }

  /** {@inheritDoc RecordingLocks.runIfFree} */
  async runIfFree<T>(id: string, task: () => Promise<T>): Promise<{ readonly value: T } | null> {
    if (this.#held.has(id)) {
      return null;
    }

    this.#held.add(id);

    try {
      return { value: await task() };
    } finally {
      this.#held.delete(id);
    }
  }
}

const LOCK_PREFIX = 'micras-monitor/session/';

/** The subset of `navigator.locks` the monitor uses. */
export interface LockManagerLike {
  request<T>(
    name: string,
    options: { readonly mode: 'exclusive'; readonly ifAvailable?: boolean },
    callback: (lock: unknown) => T | Promise<T>
  ): Promise<T>;
}

/** Locks shared by every tab of the origin, over the Web Locks API. */
export class WebLocks implements RecordingLocks {
  readonly #locks: LockManagerLike;

  constructor(locks: LockManagerLike) {
    this.#locks = locks;
  }

  /** {@inheritDoc RecordingLocks.hold} */
  hold(id: string): Promise<() => void> {
    return new Promise((resolve, reject) => {
      this.#locks
        .request(
          LOCK_PREFIX + id,
          { mode: 'exclusive' },
          () =>
            new Promise<void>((release) => {
              resolve(release);
            })
        )
        .catch(reject);
    });
  }

  /**
   * {@inheritDoc RecordingLocks.held} Asked by trying to take the lock without waiting, which is
   * given back at once when it was free.
   */
  held(id: string): Promise<boolean> {
    return this.#locks.request(LOCK_PREFIX + id, { mode: 'exclusive', ifAvailable: true }, (lock) =>
      Promise.resolve(lock === null)
    );
  }

  /** {@inheritDoc RecordingLocks.runIfFree} */
  runIfFree<T>(id: string, task: () => Promise<T>): Promise<{ readonly value: T } | null> {
    return this.#locks.request(
      LOCK_PREFIX + id,
      { mode: 'exclusive', ifAvailable: true },
      async (lock) => (lock === null ? null : { value: await task() })
    );
  }
}

/** A session id from the time it starts, sortable, with a random tail against collisions. */
export function sessionId(nowMs: number, random: () => number = Math.random): string {
  const stamp = new Date(nowMs).toISOString().replaceAll(/[-:]/g, '').replace('.', '');
  const tail = Math.floor(random() * 36 ** 4)
    .toString(36)
    .padStart(4, '0');
  return `${stamp.slice(0, 18)}-${tail}`;
}

/** Whether a value read back from storage is a session description. */
export function isRecordingInfo(value: unknown): value is RecordingInfo {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const info: Partial<Record<keyof RecordingInfo, unknown>> = value;
  return (
    typeof info.id === 'string' &&
    typeof info.name === 'string' &&
    (info.robot === null || typeof info.robot === 'string') &&
    typeof info.createdAtMs === 'number' &&
    typeof info.updatedAtMs === 'number' &&
    (info.state === 'recording' || info.state === 'saved') &&
    typeof info.bytes === 'number' &&
    typeof info.samples === 'number' &&
    typeof info.durationUs === 'number'
  );
}

/** Newest first. */
export function byNewest(left: RecordingInfo, right: RecordingInfo): number {
  return right.createdAtMs - left.createdAtMs;
}
