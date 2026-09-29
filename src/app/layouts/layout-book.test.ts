import { afterEach, describe, expect, test } from 'vitest';

import { createDesktop, createWorkspace, leaf, serializeDesktop } from '@/tiling';

import type { WindowPayload } from '../windows/types';
import {
  BACKUP_PREFIX,
  LayoutBook,
  RECORD_VERSION,
  safeLocalStorage,
  STORAGE_PREFIX,
} from './layout-book';
import { MemoryStorage } from './memory-storage';

function desktop(...variables: string[]) {
  return createDesktop<WindowPayload>(
    [createWorkspace('Main', leaf('plot-1'))],
    [{ id: 'plot-1', kind: 'plot', payload: { title: 'P', variables } }]
  );
}

const PRESETS = [{ name: 'Mine', root: { window: { kind: 'log' } } }];

describe('the saved layouts', () => {
  test('give back what was saved for a robot', () => {
    const book = new LayoutBook(new MemoryStorage());
    book.save('package:micras', { desktop: desktop('a', 'b'), presets: PRESETS }, ['a', 'b']);
    const loaded = book.load('package:micras', ['a', 'b']);
    expect(loaded?.desktop).toEqual(desktop('a', 'b'));
    expect(loaded?.presets).toEqual(PRESETS);
    expect(book.load('package:other', [])).toBeNull();
  });

  test('keep a layout per robot under its own storage key', () => {
    const storage = new MemoryStorage();
    const book = new LayoutBook(storage);
    book.save('package:micras', { desktop: desktop('a'), presets: [] }, []);
    book.save('name:rover', { desktop: desktop('z'), presets: [] }, []);
    expect(storage.getItem(`${STORAGE_PREFIX}package:micras`)).not.toBeNull();
    expect(book.load('name:rover', [])?.desktop?.windows.get('plot-1')?.payload.variables).toEqual([
      'z',
    ]);
  });

  test('write a version and the desktop as the tiling engine serializes it', () => {
    const storage = new MemoryStorage();
    new LayoutBook(storage).save('package:m', { desktop: desktop('a'), presets: [] }, []);
    expect(JSON.parse(storage.getItem(`${STORAGE_PREFIX}package:m`) ?? '')).toEqual({
      version: RECORD_VERSION,
      desktop: serializeDesktop(desktop('a')),
      presets: [],
    });
  });

  test('ignore an entry of another version', () => {
    const storage = new MemoryStorage();
    const record = {
      version: RECORD_VERSION + 1,
      desktop: serializeDesktop(desktop('a')),
      presets: [],
    };
    storage.setItem(`${STORAGE_PREFIX}package:m`, JSON.stringify(record));
    storage.setItem(`${STORAGE_PREFIX}package:old`, JSON.stringify({ ...record, version: 0 }));
    const book = new LayoutBook(storage);
    expect(book.load('package:m', [])).toBeNull();
    expect(book.load('package:old', [])).toBeNull();
  });

  test('ignore an entry that is not JSON or not an object', () => {
    const storage = new MemoryStorage();
    storage.setItem(`${STORAGE_PREFIX}package:a`, '{"version": 1, ');
    storage.setItem(`${STORAGE_PREFIX}package:b`, '[1, 2]');
    storage.setItem(`${STORAGE_PREFIX}package:c`, 'null');
    const book = new LayoutBook(storage);
    expect(book.load('package:a', [])).toBeNull();
    expect(book.load('package:b', [])).toBeNull();
    expect(book.load('package:c', [])).toBeNull();
  });

  test('keep the presets of an entry whose desktop is corrupt', () => {
    const storage = new MemoryStorage();
    const snapshot = serializeDesktop(desktop('a'));
    const broken = {
      ...snapshot,
      workspaces: [{ ...snapshot.workspaces[0], root: { type: 'leaf', id: 'ghost' } }],
    };
    storage.setItem(
      `${STORAGE_PREFIX}package:m`,
      JSON.stringify({ version: RECORD_VERSION, desktop: broken, presets: PRESETS })
    );
    expect(new LayoutBook(storage).load('package:m', [])).toEqual({
      desktop: null,
      presets: PRESETS,
    });
  });

  test('reject a window whose payload is not a title and a list of names', () => {
    const storage = new MemoryStorage();
    const snapshot = serializeDesktop(desktop('a'));
    const payloads: unknown[] = [
      null,
      { variables: 'a' },
      { variables: [1] },
      { title: 3, variables: [] },
    ];

    for (const payload of payloads) {
      const bad = { ...snapshot, windows: [{ ...snapshot.windows[0], payload }] };
      storage.setItem(
        `${STORAGE_PREFIX}package:m`,
        JSON.stringify({ version: RECORD_VERSION, desktop: bad, presets: [] })
      );
      expect(new LayoutBook(storage).load('package:m', [])?.desktop).toBeNull();
    }
  });

  test('do nothing without storage, and survive storage that refuses', () => {
    const none = new LayoutBook(null);
    none.save('package:m', { desktop: desktop('a'), presets: [] }, []);
    expect(none.load('package:m', [])).toBeNull();

    const full = new MemoryStorage();
    full.setItem = () => {
      throw new Error('quota');
    };
    const book = new LayoutBook(full);
    expect(() => book.save('package:m', { desktop: desktop('a'), presets: [] }, [])).not.toThrow();
  });
});

function saved(key: string, names: readonly string[]) {
  const storage = new MemoryStorage();
  new LayoutBook(storage).save(key, { desktop: desktop(...names), presets: PRESETS }, names);
  return storage;
}

describe('the layouts of a robot known only by its variable names', () => {
  const NAMES = Array.from({ length: 10 }, (_, index) => `v${index}`);

  test('find the layout again for the very same names', () => {
    const storage = saved('signature:aaaa', NAMES);
    expect(new LayoutBook(storage).load('signature:aaaa', NAMES)?.presets).toEqual(PRESETS);
  });

  test('find the layout of a schema that gained a variable, and copy it to the new key', () => {
    const storage = saved('signature:aaaa', NAMES);
    const book = new LayoutBook(storage);
    const loaded = book.load('signature:bbbb', [...NAMES, 'v10']);
    expect(loaded?.desktop).toEqual(desktop(...NAMES));
    expect(storage.getItem(`${STORAGE_PREFIX}signature:aaaa`)).not.toBeNull();
  });

  test('keep two similar robots apart once each has edited its copy', () => {
    const storage = saved('signature:aaaa', NAMES);
    const book = new LayoutBook(storage);
    const other = [...NAMES, 'v10'];
    book.load('signature:bbbb', other);
    book.save('signature:bbbb', { desktop: desktop('only-b'), presets: [] }, other);

    expect(book.load('signature:aaaa', NAMES)?.desktop).toEqual(desktop(...NAMES));
    expect(book.load('signature:bbbb', other)?.desktop).toEqual(desktop('only-b'));
  });

  test('do not take the layout of a robot with mostly other variables', () => {
    const storage = saved('signature:aaaa', NAMES);
    const book = new LayoutBook(storage);
    expect(
      book.load('signature:bbbb', [...NAMES.slice(0, 5), 'w1', 'w2', 'w3', 'w4', 'w5'])
    ).toBeNull();
    expect(storage.getItem(`${STORAGE_PREFIX}signature:aaaa`)).not.toBeNull();
  });

  test('take the closest of several, and never one filed under a name or a package', () => {
    const storage = saved('signature:near', NAMES);
    new LayoutBook(storage).save('signature:far', { desktop: desktop('x'), presets: [] }, [
      'x',
      ...NAMES.slice(0, 8),
    ]);
    new LayoutBook(storage).save('name:rover', { desktop: desktop('n'), presets: [] }, NAMES);
    const loaded = new LayoutBook(storage).load('signature:new', [...NAMES, 'extra']);
    expect(loaded?.desktop).toEqual(desktop(...NAMES));
  });

  test('never adopt the layout of a key that is not a signature', () => {
    const storage = saved('signature:aaaa', NAMES);
    expect(new LayoutBook(storage).load('name:rover', NAMES)).toBeNull();
  });
});

describe('the last robot', () => {
  test('is remembered and read back', () => {
    const book = new LayoutBook(new MemoryStorage());
    expect(book.last()).toBeNull();
    book.remember('name:rover');
    expect(book.last()).toBe('name:rover');
  });

  test('is not taken for a robot when looking for near signatures', () => {
    const storage = new MemoryStorage();
    const book = new LayoutBook(storage);
    book.remember('signature:aaaa');
    expect(book.load('signature:bbbb', ['a'])).toBeNull();
  });
});

describe('an entry that cannot be read', () => {
  test('is told from a missing one, and copied aside on request', () => {
    const storage = new MemoryStorage();
    storage.setItem(`${STORAGE_PREFIX}name:a`, JSON.stringify({ version: RECORD_VERSION + 1 }));
    const book = new LayoutBook(storage);
    expect(book.unreadable('name:a')).toBe(true);
    expect(book.unreadable('name:missing')).toBe(false);
    book.save('name:ok', { desktop: desktop('a'), presets: [] }, []);
    expect(book.unreadable('name:ok')).toBe(false);

    book.backup('name:a');
    expect(storage.getItem(`${BACKUP_PREFIX}name:a`)).toBe(
      storage.getItem(`${STORAGE_PREFIX}name:a`)
    );
    expect(() => book.backup('name:missing')).not.toThrow();
  });
});

describe('the browser storage', () => {
  afterEach(() => {
    Reflect.deleteProperty(globalThis, 'localStorage');
  });

  test('is null where reading it throws', () => {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get: () => {
        throw new Error('blocked');
      },
    });
    expect(safeLocalStorage()).toBeNull();
  });

  test('is null where there is none', () => {
    expect(safeLocalStorage()).toBeNull();
  });
});
