/**
 * Where saved sessions live: one recording file and a small description per session, and a lock
 * that tells a session another tab is recording from one whose tab died.
 *
 * @module
 */

import type { RecordingFile } from '@/telemetry';

/** Whether a session is being recorded, or its recording ended. */
export type SessionState = 'recording' | 'saved';

/** What recovering a recording cut short found. */
export interface SessionRecovery {
  /** When it was recovered, in `Date.now()` milliseconds. */
  readonly recoveredAtMs: number;
  /** Bytes of the incomplete last record, cut from the file. */
  readonly truncatedBytes: number;
  /** Records skipped in the middle of the file because they were damaged. */
  readonly damagedRecords: number;
}

/** A saved session, as the sessions list shows it. */
export interface SessionInfo {
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
  readonly state: SessionState;
  /** The size of its file, as of the last update. */
  readonly bytes: number;
  /** The samples of its blocks, as of the last update. */
  readonly samples: number;
  /** The span of its samples on the session timeline, as of the last update. */
  readonly durationUs: number;
  /** What its recovery found, if it was cut short. */
  readonly recovery?: SessionRecovery;
}

/** The part of a session's description that can change after it is made. */
export type SessionUpdate = Partial<
  Pick<SessionInfo, 'name' | 'state' | 'bytes' | 'samples' | 'durationUs' | 'recovery'>
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
export interface SessionLibrary {
  /** Where the files are: the Origin Private File System, or memory when it is not available. */
  readonly kind: 'opfs' | 'memory';

  /** Every session, newest first. */
  list(): Promise<SessionInfo[]>;

  /**
   * Make a session and its empty recording file, open for writing.
   *
   * @throws If there is no room, or the file system refuses.
   */
  create(
    info: Omit<SessionInfo, 'id' | 'updatedAtMs'>
  ): Promise<{ readonly info: SessionInfo; readonly file: RecordingFile }>;

  /**
   * Open a session's recording file. Opening a file already open shares it; each opening is
   * closed on its own.
   */
  open(id: string): Promise<RecordingFile>;

  /** Change a session's description. */
  update(id: string, update: SessionUpdate): Promise<SessionInfo>;

  /** Delete a session and its file; its file must not be open. */
  remove(id: string): Promise<void>;

  /** How much the origin stores and may store, if the browser tells. */
  estimate(): Promise<StorageEstimate | null>;

  /** Ask the browser to keep the origin's data under storage pressure; whether it will. */
  persist(): Promise<boolean>;
}

/** Tells a session a live tab records from one left behind by a tab that died. */
export interface SessionLocks {
  /**
   * Hold a session's lock until the returned function is called, or the tab dies.
   *
   * @returns The function that lets go of it.
   */
  hold(id: string): Promise<() => void>;

  /** Whether any tab holds a session's lock. */
  held(id: string): Promise<boolean>;
}

/** Locks for one tab alone, for tests and for browsers without Web Locks. */
export class MemoryLocks implements SessionLocks {
  readonly #held = new Set<string>();

  /** {@inheritDoc SessionLocks.hold} */
  hold(id: string): Promise<() => void> {
    this.#held.add(id);
    return Promise.resolve(() => this.#held.delete(id));
  }

  /** {@inheritDoc SessionLocks.held} */
  held(id: string): Promise<boolean> {
    return Promise.resolve(this.#held.has(id));
  }
}

const LOCK_PREFIX = 'micras-monitor/session/';

/** The subset of `navigator.locks` the monitor uses. */
export interface LockManagerLike {
  request(
    name: string,
    options: { readonly mode: 'exclusive' },
    callback: () => Promise<void>
  ): Promise<unknown>;
  query(): Promise<{ readonly held?: readonly { readonly name?: string }[] }>;
}

/** Locks shared by every tab of the origin, over the Web Locks API. */
export class WebLocks implements SessionLocks {
  readonly #locks: LockManagerLike;

  constructor(locks: LockManagerLike) {
    this.#locks = locks;
  }

  /** {@inheritDoc SessionLocks.hold} */
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

  /** {@inheritDoc SessionLocks.held} */
  async held(id: string): Promise<boolean> {
    const { held = [] } = await this.#locks.query();
    return held.some((lock) => lock.name === LOCK_PREFIX + id);
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
export function isSessionInfo(value: unknown): value is SessionInfo {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const info: Partial<Record<keyof SessionInfo, unknown>> = value;
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
export function byNewest(left: SessionInfo, right: SessionInfo): number {
  return right.createdAtMs - left.createdAtMs;
}
