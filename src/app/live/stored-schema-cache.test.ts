import { describe, expect, test } from 'vitest';

import type { SchemaEntry } from '@/link';
import { decodeAccess, TypeCode } from '@/protocol';

import { MemoryStorage } from '../layouts/memory-storage';
import { StoredSchemaCache } from './stored-schema-cache';

const SCHEMA: readonly SchemaEntry[] = [
  { id: 0, name: 'state', type: TypeCode.U8, access: decodeAccess(0x01) },
  { id: 1, name: 'maze', type: TypeCode.BLOB, access: decodeAccess(0x08), typeTag: 'maze-grid' },
  { id: 2, name: 'run_profile', type: TypeCode.U8, access: decodeAccess(0x07) },
];
const HASH = 0xdeadbeef;

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
});
