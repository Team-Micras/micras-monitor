/**
 * The layouts saved for each robot, in the browser's storage: one versioned entry per robot
 * key, holding its desktop and the presets the user made for it.
 *
 * @module
 */

import type { LayoutPreset } from '@/robot-kit';
import { restoreDesktop, serializeDesktop, type Desktop } from '@/tiling';

import type { WindowPayload } from '../windows/types';
import { overlap, SIGNATURE_PREFIX } from './layout-key';
import { readPresets } from './presets';

/** The format of a saved entry. An entry of another version is ignored, and replaced on save. */
export const RECORD_VERSION = 1;

/** The prefix of every storage key the book uses. */
export const STORAGE_PREFIX = 'micras-monitor/layouts/';

/** The key that holds the key of the robot whose layout was shown last. */
export const LAST_KEY = `${STORAGE_PREFIX}last`;

/** The prefix of the keys where an unreadable entry is copied before it is overwritten. */
export const BACKUP_PREFIX = `${STORAGE_PREFIX}backup/`;

/** How much the variable names of a robot known only by them may differ from the saved ones. */
export const MIN_SIGNATURE_OVERLAP = 0.8;

/** The part of `Storage` the book uses, so that tests and other stores can stand in. */
export type LayoutStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'>;

/** What is saved for one robot. */
export interface StoredLayout {
  /** The desktop, or null when the saved one could not be read. */
  readonly desktop: Desktop<WindowPayload> | null;
  /** The user's presets for this robot. */
  readonly presets: readonly LayoutPreset[];
}

interface ParsedRecord extends StoredLayout {
  readonly names: readonly string[];
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readPayload(value: unknown): WindowPayload {
  if (!isRecord(value) || !Array.isArray(value.variables)) {
    throw new TypeError('must be an object with a list of variables');
  }

  const { title, variables } = value;

  if (
    !variables.every((name) => typeof name === 'string') ||
    (title !== undefined && typeof title !== 'string')
  ) {
    throw new TypeError('must have a text title and text variable names');
  }

  return title === undefined ? { variables } : { title, variables };
}

function readDesktop(value: unknown): Desktop<WindowPayload> | null {
  try {
    return restoreDesktop(value, { readPayload });
  } catch {
    return null;
  }
}

function parse(raw: string): ParsedRecord | null {
  try {
    const value: unknown = JSON.parse(raw);

    if (!isRecord(value) || value.version !== RECORD_VERSION) {
      return null;
    }

    const names = Array.isArray(value.names)
      ? value.names.filter((name): name is string => typeof name === 'string')
      : [];
    return { desktop: readDesktop(value.desktop), presets: readPresets(value.presets), names };
  } catch {
    return null;
  }
}

/**
 * `localStorage`, or null where reading it throws, as with storage blocked by the browser.
 */
export function safeLocalStorage(): LayoutStorage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/**
 * Reads and writes the saved layouts of every robot. Nothing coordinates two tabs of the
 * monitor: the tab that writes last wins.
 */
export class LayoutBook {
  readonly #storage: LayoutStorage | null;

  /** @param storage Where to keep them; without one, nothing is kept. */
  constructor(storage: LayoutStorage | null) {
    this.#storage = storage;
  }

  /**
   * What is saved for a robot key. An entry that is corrupt, or of a version this build does not
   * know, counts as none, and one whose desktop cannot be restored still gives its presets.
   *
   * A robot known only by its variable names (a `signature:` key) whose names gained or lost a
   * few since it was saved finds the entry of the closest names, at least
   * {@link MIN_SIGNATURE_OVERLAP} alike; the new key starts as a copy of that entry, which stays
   * where it is, so that two similar robots each keep their own from then on.
   *
   * @param key The robot's key, as `layoutKey` gives it.
   * @param names The names of the robot's variables.
   */
  load(key: string, names: readonly string[]): StoredLayout | null {
    const raw = this.#read(key);

    if (raw !== null) {
      const record = parse(raw);
      return record === null ? null : { desktop: record.desktop, presets: record.presets };
    }

    if (!key.startsWith(SIGNATURE_PREFIX)) {
      return null;
    }

    const closest = this.#closest(key, names);

    if (closest === null) {
      return null;
    }

    return { desktop: closest.record.desktop, presets: closest.record.presets };
  }

  /**
   * Saves what a robot has now. Storage that is full or unavailable loses the save quietly: the
   * layout on screen is not affected.
   *
   * @param key The robot's key, as `layoutKey` gives it.
   * @param layout The desktop and the user's presets to keep.
   * @param names The names of the robot's variables, kept for a `signature:` key.
   */
  save(
    key: string,
    layout: { readonly desktop: Desktop<WindowPayload>; readonly presets: readonly LayoutPreset[] },
    names: readonly string[]
  ): void {
    const record = {
      version: RECORD_VERSION,
      ...(key.startsWith(SIGNATURE_PREFIX) ? { names } : {}),
      desktop: serializeDesktop(layout.desktop),
      presets: layout.presets,
    };

    try {
      this.#storage?.setItem(STORAGE_PREFIX + key, JSON.stringify(record));
    } catch {
      return;
    }
  }

  /** The key of the robot whose layout was saved last, or null. */
  last(): string | null {
    try {
      return this.#storage?.getItem(LAST_KEY) ?? null;
    } catch {
      return null;
    }
  }

  /** Remembers the robot whose layout was saved last, for `last`. */
  remember(key: string): void {
    try {
      this.#storage?.setItem(LAST_KEY, key);
    } catch {
      return;
    }
  }

  /** Whether an entry exists for the key but cannot be read, as one of a newer version. */
  unreadable(key: string): boolean {
    const raw = this.#read(key);
    return raw !== null && parse(raw) === null;
  }

  /** Copies the entry of a key to where it is kept apart, before something replaces it. */
  backup(key: string): void {
    const raw = this.#read(key);

    try {
      if (raw !== null) {
        this.#storage?.setItem(BACKUP_PREFIX + key, raw);
      }
    } catch {
      return;
    }
  }

  #read(key: string): string | null {
    try {
      return this.#storage?.getItem(STORAGE_PREFIX + key) ?? null;
    } catch {
      return null;
    }
  }

  #closest(key: string, names: readonly string[]): { key: string; record: ParsedRecord } | null {
    const storage = this.#storage;
    let best: { key: string; record: ParsedRecord; score: number } | null = null;

    if (storage === null) {
      return null;
    }

    const candidates = Array.from({ length: storage.length }, (_, index) => storage.key(index))
      .filter(
        (name): name is string => name?.startsWith(STORAGE_PREFIX + SIGNATURE_PREFIX) ?? false
      )
      .map((name) => name.slice(STORAGE_PREFIX.length))
      .filter((candidate) => candidate !== key)
      .toSorted();

    for (const candidate of candidates) {
      const raw = this.#read(candidate);
      const record = raw === null ? null : parse(raw);
      const score = record === null ? 0 : overlap(names, record.names);

      if (record !== null && score >= MIN_SIGNATURE_OVERLAP && score > (best?.score ?? 0)) {
        best = { key: candidate, record, score };
      }
    }

    return best;
  }
}
