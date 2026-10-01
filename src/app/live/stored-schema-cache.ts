/**
 * Schemas kept between page loads, so a monitor that reconnects to a robot running the same build
 * skips the paged schema.
 *
 * @module
 */

import { decodeAccess, encodeAccess, TypeCode } from '@/protocol';
import type { SchemaCache, SchemaEntry } from '@/link';

/** The part of `localStorage` the cache uses. */
export type SchemaStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'>;

/** How many schemas are kept by default; the one stored longest ago goes first. */
export const DEFAULT_SCHEMA_LIMIT = 8;

const PREFIX = 'micras-monitor/schema/';
const INDEX_KEY = 'micras-monitor/schemas';
const RECORD_VERSION = 1;

type StoredEntry = readonly [name: string, type: TypeCode, access: number, typeTag?: string];

function keyOf(hash: number): string {
  return `${PREFIX}${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

function isTypeCode(value: unknown): value is TypeCode {
  return typeof value === 'number' && Number.isInteger(value) && value in TypeCode;
}

function readEntry(value: unknown, id: number): SchemaEntry | null {
  if (!Array.isArray(value) || value.length < 3 || value.length > 4) {
    return null;
  }

  const [name, type, access, typeTag]: unknown[] = value;

  if (
    typeof name !== 'string' ||
    !isTypeCode(type) ||
    !Number.isInteger(access) ||
    (typeTag !== undefined && typeof typeTag !== 'string')
  ) {
    return null;
  }

  const entry = { id, name, type, access: decodeAccess(Number(access)) };
  return typeTag === undefined ? entry : { ...entry, typeTag };
}

function readRecord(raw: string): readonly SchemaEntry[] | null {
  try {
    const value: unknown = JSON.parse(raw);

    if (
      typeof value !== 'object' ||
      value === null ||
      !('version' in value) ||
      value.version !== RECORD_VERSION ||
      !('entries' in value) ||
      !Array.isArray(value.entries)
    ) {
      return null;
    }

    const entries = value.entries.map((entry: unknown, id) => readEntry(entry, id));
    return entries.every((entry) => entry !== null) ? entries : null;
  } catch {
    return null;
  }
}

function isQuotaExceeded(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'QuotaExceededError';
}

function readIndex(raw: string | null): number[] {
  try {
    const value: unknown = raw === null ? [] : JSON.parse(raw);
    return Array.isArray(value) ? value.filter((hash) => Number.isInteger(hash)) : [];
  } catch {
    return [];
  }
}

/**
 * A schema cache over `localStorage`, keyed by the schema's hash. It also holds what it read or
 * stored in memory, so a page whose storage is full or blocked still learns each schema once.
 * A record that is corrupt, or of a version this build does not know, counts as none.
 *
 * A new schema is written before anything is dropped, so a write that fails loses no schema kept
 * so far; a storage that is full gives up the schema stored longest ago and is tried once more.
 * Schema records the index no longer names, as one left by a write cut short, are swept away.
 */
export class StoredSchemaCache implements SchemaCache {
  readonly #storage: SchemaStorage | null;
  readonly #limit: number;
  readonly #memory = new Map<number, readonly SchemaEntry[]>();

  /**
   * @param storage Where to keep the schemas; without one, they last as long as the page.
   * @param limit How many schemas to keep in the storage; at least one.
   */
  constructor(storage: SchemaStorage | null, limit = DEFAULT_SCHEMA_LIMIT) {
    this.#storage = storage;
    this.#limit = Math.max(1, Math.floor(limit));
  }

  load(hash: number): readonly SchemaEntry[] | undefined {
    const known = this.#memory.get(hash);

    if (known !== undefined) {
      return known;
    }

    const raw = this.#attempt(() => this.#storage?.getItem(keyOf(hash)) ?? null) ?? null;
    const entries = raw === null ? null : readRecord(raw);

    if (entries === null) {
      return undefined;
    }

    this.#memory.set(hash, entries);
    return entries;
  }

  store(hash: number, entries: readonly SchemaEntry[]): void {
    this.#memory.set(hash, entries);
    const record = {
      version: RECORD_VERSION,
      entries: entries.map(({ name, type, access, typeTag }): StoredEntry =>
        typeTag === undefined
          ? [name, type, encodeAccess(access)]
          : [name, type, encodeAccess(access), typeTag]
      ),
    };
    const storage = this.#storage;

    if (storage !== null) {
      this.#attempt(() => this.#keep(storage, hash, JSON.stringify(record)));
    }
  }

  #keep(storage: SchemaStorage, hash: number, record: string): void {
    const older = readIndex(storage.getItem(INDEX_KEY)).filter((known) => known !== hash);

    try {
      storage.setItem(keyOf(hash), record);
    } catch (error) {
      const oldest = older.shift();

      if (!isQuotaExceeded(error) || oldest === undefined) {
        throw error;
      }

      storage.removeItem(keyOf(oldest));
      storage.setItem(INDEX_KEY, JSON.stringify(older));
      storage.setItem(keyOf(hash), record);
    }

    const index = [...older, hash];
    const evicted = index.splice(0, Math.max(0, index.length - this.#limit));
    storage.setItem(INDEX_KEY, JSON.stringify(index));
    evicted.forEach((old) => storage.removeItem(keyOf(old)));
    this.#sweep(storage, new Set(index.map(keyOf)));
  }

  #sweep(storage: SchemaStorage, kept: ReadonlySet<string>): void {
    const orphans: string[] = [];

    for (let index = 0; index < storage.length; index++) {
      const key = storage.key(index);

      if (key?.startsWith(PREFIX) === true && !kept.has(key)) {
        orphans.push(key);
      }
    }

    orphans.forEach((key) => storage.removeItem(key));
  }

  #attempt<T>(use: () => T): T | undefined {
    try {
      return use();
    } catch {
      return undefined;
    }
  }
}
