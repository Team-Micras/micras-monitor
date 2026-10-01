import { describe, expect, test } from 'vitest';

import type { SchemaEntry } from '@/sources/micras-comm/link';
import { decodeAccess, TypeCode } from '@/sources/micras-comm/wire';

import { MemoryStorage } from '@tests/support/ui/layouts/memory-storage';
import { StoredSchemaCache } from '@/sources/micras-comm/schema-storage';

const SCHEMA: readonly SchemaEntry[] = [
  { id: 0, name: 'state', type: TypeCode.U8, access: decodeAccess(0x01) },
  { id: 1, name: 'maze', type: TypeCode.BLOB, access: decodeAccess(0x08), typeTag: 'maze-grid' },
  { id: 2, name: 'run_profile', type: TypeCode.U8, access: decodeAccess(0x07) },
];
const HASH = 0xdeadbeef;

/** Storage that holds at most some characters, keys and values, as a browser's quota does. */
class LimitedStorage extends MemoryStorage {
  readonly #capacity: number;

  constructor(capacity: number) {
    super();
    this.#capacity = capacity;
  }

  override setItem(key: string, value: string): void {
    const others =
      this.#used() - (this.getItem(key) === null ? 0 : key.length + this.getItem(key)!.length);

    if (others + key.length + value.length > this.#capacity) {
      throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
    }

    super.setItem(key, value);
  }

  #used(): number {
    let used = 0;

    for (let index = 0; index < this.length; index++) {
      const key = this.key(index) ?? '';
      used += key.length + (this.getItem(key)?.length ?? 0);
    }

    return used;
  }
}

function sizeOfOne(): number {
  const storage = new MemoryStorage();
  new StoredSchemaCache(storage).store(1, SCHEMA);
  let used = 0;

  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index) ?? '';
    used += key.length + (storage.getItem(key)?.length ?? 0);
  }

  return used + 8;
}

describe('StoredSchemaCache', () => {
  test('gives a schema stored on an earlier page load back by its hash', () => {
    const storage = new MemoryStorage();
    new StoredSchemaCache(storage).store(HASH, SCHEMA);

    const reloaded = new StoredSchemaCache(storage);
    expect(reloaded.load(HASH)).toEqual(SCHEMA);
    expect(reloaded.load(0x1234)).toBeUndefined();
  });

  test('counts a corrupt record, or one of another version, as none', () => {
    const storage = new MemoryStorage();
    new StoredSchemaCache(storage).store(HASH, SCHEMA);
    const key = 'micras-monitor/schema/deadbeef';

    storage.setItem(key, '{"version":1,"entries":[["state",99,1]]}');
    expect(new StoredSchemaCache(storage).load(HASH)).toBeUndefined();
    storage.setItem(key, '{"version":2,"entries":[]}');
    expect(new StoredSchemaCache(storage).load(HASH)).toBeUndefined();
    storage.setItem(key, 'not json');
    expect(new StoredSchemaCache(storage).load(HASH)).toBeUndefined();
  });

  test('keeps the most recent schemas up to its limit', () => {
    const storage = new MemoryStorage();
    const cache = new StoredSchemaCache(storage, 2);
    cache.store(1, SCHEMA);
    cache.store(2, SCHEMA);
    cache.store(1, SCHEMA);
    cache.store(3, SCHEMA);

    const reloaded = new StoredSchemaCache(storage, 2);
    expect(reloaded.load(2)).toBeUndefined();
    expect(reloaded.load(1)).toEqual(SCHEMA);
    expect(reloaded.load(3)).toEqual(SCHEMA);
  });

  test('keeps schemas for the page when the storage throws', () => {
    const blocked = {
      length: 0,
      key: () => null,
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => undefined,
    };
    const cache = new StoredSchemaCache(blocked);
    cache.store(HASH, SCHEMA);
    expect(cache.load(HASH)).toEqual(SCHEMA);
    expect(new StoredSchemaCache(null).load(HASH)).toBeUndefined();
  });

  test('makes room in a full storage by dropping the schema stored longest ago, once', () => {
    const storage = new LimitedStorage(sizeOfOne());
    const cache = new StoredSchemaCache(storage, 2);
    cache.store(1, SCHEMA);
    cache.store(2, SCHEMA);
    cache.store(3, SCHEMA);

    const reloaded = new StoredSchemaCache(storage, 2);
    expect(reloaded.load(1)).toBeUndefined();
    expect(reloaded.load(2)).toBeUndefined();
    expect(reloaded.load(3)).toEqual(SCHEMA);
  });

  test('drops nothing it kept when writing a new schema fails', () => {
    const storage = new MemoryStorage();
    const cache = new StoredSchemaCache(storage, 2);
    cache.store(1, SCHEMA);
    cache.store(2, SCHEMA);
    const setItem = storage.setItem.bind(storage);
    storage.setItem = (key, value) => {
      if (key.endsWith('00000003')) {
        throw new Error('blocked');
      }

      setItem(key, value);
    };
    cache.store(3, SCHEMA);

    const reloaded = new StoredSchemaCache(storage, 2);
    expect(reloaded.load(1)).toEqual(SCHEMA);
    expect(reloaded.load(2)).toEqual(SCHEMA);
    expect(cache.load(3)).toEqual(SCHEMA);
  });

  test('keeps at least the latest schema whatever limit it is given', () => {
    const storage = new MemoryStorage();
    new StoredSchemaCache(storage, 0).store(HASH, SCHEMA);
    expect(new StoredSchemaCache(storage, 0).load(HASH)).toEqual(SCHEMA);
  });

  test('sweeps schema records its index does not name', () => {
    const storage = new MemoryStorage();
    storage.setItem('micras-monitor/schema/0000abcd', '{"version":1,"entries":[]}');
    storage.setItem('micras-monitor/keymap', '{}');
    new StoredSchemaCache(storage).store(HASH, SCHEMA);
    expect(storage.getItem('micras-monitor/schema/0000abcd')).toBeNull();
    expect(storage.getItem('micras-monitor/keymap')).toBe('{}');
    expect(storage.getItem('micras-monitor/schema/deadbeef')).not.toBeNull();
  });
});
