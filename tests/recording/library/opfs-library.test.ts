import { describe, expect, test } from 'vitest';

import {
  DirectTransport,
  FakeDirectory,
  FakeFile,
} from '@tests/support/recording/library/fake-opfs';
import { isHostRequest, OpfsHost, type HostResponse } from '@/recording/library/opfs-host';
import {
  MessageTransport,
  OpfsSessionLibrary,
  type MessageTarget,
  type StorageManagerLike,
} from '@/recording/library/opfs-library';
import { sessionId, type SessionInfo } from '@/recording/library/recording-library';

const NEW_SESSION: Omit<SessionInfo, 'updatedAtMs'> = {
  id: sessionId(Date.UTC(2026, 8, 29, 10, 42)),
  name: 'micras · 29 Sep 10:42',
  robot: 'micras',
  createdAtMs: Date.UTC(2026, 8, 29, 10, 42),
  state: 'recording',
  bytes: 0,
  samples: 0,
  durationUs: 0,
};

function library(root = new FakeDirectory(), storage?: StorageManagerLike) {
  const transport = new DirectTransport(root);
  return { root, transport, library: new OpfsSessionLibrary(transport, storage, () => 1234) };
}

function recordingOf(root: FakeDirectory, id: string): FakeFile {
  const file = root.at('micras-monitor', 'sessions', id, 'recording.mmrec');

  if (!(file instanceof FakeFile)) {
    throw new Error(`No recording for ${id}`);
  }

  return file;
}

function tear(root: FakeDirectory, id: string, name: string): void {
  const description = root.at('micras-monitor', 'sessions', id, name);

  if (!(description instanceof FakeFile)) {
    throw new Error(`No ${name} for ${id}`);
  }

  description.bytes = new TextEncoder().encode('{"id": "tru');
}

describe('the OPFS session library', () => {
  test('lays out each session as a directory with its description and its recording', async () => {
    const { root, library: sessions } = library();
    const { info, file } = await sessions.create(NEW_SESSION);

    expect(info).toEqual({ ...NEW_SESSION, id: info.id, updatedAtMs: 1234 });
    expect(info.id).toMatch(/^20260929T104200000-[0-9a-z]{4}$/);
    expect(root.at('micras-monitor', 'sessions', info.id, 'session.json')).toBeInstanceOf(FakeFile);
    expect(await sessions.list()).toEqual([info]);
    expect(await file.size()).toBe(0);
  });

  test('appends durably at positions and reads back slices', async () => {
    const { root, library: sessions } = library();
    const { info, file } = await sessions.create(NEW_SESSION);
    await file.write(0, new Uint8Array([1, 2, 3, 4]));
    await file.write(4, new Uint8Array([5, 6]));
    await file.write(2, new Uint8Array([9]));

    expect(await file.size()).toBe(6);
    expect(await file.read(1, 4)).toEqual(new Uint8Array([2, 9, 4, 5]));
    await expect(file.read(4, 3)).rejects.toThrow(/Cannot read 3 bytes at 4 of 6/);
    expect(recordingOf(root, info.id).bytes).toEqual(new Uint8Array([1, 2, 9, 4, 5, 6]));

    await file.truncate(3);
    expect(await file.size()).toBe(3);
  });

  test('shares one access handle among openings and closes it with the last', async () => {
    const { root, library: sessions } = library();
    const { info, file } = await sessions.create(NEW_SESSION);
    const reader = await sessions.open(info.id);
    await file.write(0, new Uint8Array([7]));

    expect(await reader.read(0, 1)).toEqual(new Uint8Array([7]));
    await file.close();
    expect(recordingOf(root, info.id).locked).toBe(true);
    await expect(sessions.remove(info.id)).rejects.toThrow(/is open/);
    await reader.close();
    expect(recordingOf(root, info.id).locked).toBe(false);
    await reader.close();
    await sessions.remove(info.id);
    expect(await sessions.list()).toEqual([]);
  });

  test('rewrites the description whole, shorter or longer', async () => {
    const { library: sessions } = library();
    const { info, file } = await sessions.create(NEW_SESSION);
    await file.close();
    await sessions.update(info.id, { name: 'a much longer name than the one it had at first' });
    const renamed = await sessions.update(info.id, { name: 'short', state: 'saved', bytes: 42 });

    expect(renamed).toMatchObject({ name: 'short', state: 'saved', bytes: 42 });
    expect(await sessions.list()).toEqual([renamed]);
  });

  test('reads the other copy of a description torn in the middle of a write', async () => {
    const { root, library: sessions } = library();
    const { info, file } = await sessions.create(NEW_SESSION);
    await file.close();
    const renamed = await sessions.update(info.id, { name: 'Bench' });
    tear(root, info.id, 'session.json');

    expect(await sessions.list()).toEqual([renamed]);
    expect(await sessions.update(info.id, { state: 'saved' })).toMatchObject({
      name: 'Bench',
      state: 'saved',
    });
    expect(await sessions.list()).toEqual([
      expect.objectContaining({ name: 'Bench', state: 'saved' }),
    ]);
  });

  test('lists and updates a directory with no readable description as a recording cut short', async () => {
    const { root, library: sessions } = library();
    const { info, file } = await sessions.create(NEW_SESSION);
    await file.close();
    tear(root, info.id, 'session.json');
    tear(root, info.id, 'session.next.json');
    const stray = {
      id: info.id,
      name: info.id,
      state: 'recording',
      createdAtMs: NEW_SESSION.createdAtMs,
    };

    expect(await sessions.list()).toEqual([expect.objectContaining(stray)]);
    await sessions.update(info.id, { state: 'saved', name: 'Found' });
    expect(await sessions.list()).toEqual([
      expect.objectContaining({ id: info.id, name: 'Found', state: 'saved' }),
    ]);
  });

  test('passes a short write on as the quota error it is', async () => {
    const { root, library: sessions } = library();
    const { info, file } = await sessions.create(NEW_SESSION);
    recordingOf(root, info.id).room = 3;

    await expect(file.write(0, new Uint8Array(8))).rejects.toMatchObject({
      name: 'QuotaExceededError',
      message: 'Wrote 3 of 8 bytes',
    });
  });

  test('opens a recording again after the worker that held it died', async () => {
    const { transport, library: sessions } = library();
    const { info, file } = await sessions.create(NEW_SESSION);
    await file.write(0, new Uint8Array([1, 2]));
    transport.crash();

    const again = await sessions.open(info.id);
    expect(await again.read(0, 2)).toEqual(new Uint8Array([1, 2]));
  });

  test('opens a recording once when several accesses find the worker restarted', async () => {
    const { transport, library: sessions } = library();
    const { info, file } = await sessions.create(NEW_SESSION);
    await file.write(0, new Uint8Array([1, 2, 3]));
    transport.crash();

    const [size, bytes] = await Promise.all([file.size(), file.read(0, 2)]);
    expect(size).toBe(3);
    expect(bytes).toEqual(new Uint8Array([1, 2]));
    await file.close();
    await expect(sessions.remove(info.id)).resolves.toBeUndefined();
  });

  test('tells the quota and asks for persistence through the storage manager', async () => {
    let persisted = false;
    const storage: StorageManagerLike = {
      estimate: () => Promise.resolve({ usage: 2048, quota: 1 << 30 }),
      persist: () => {
        persisted = true;
        return Promise.resolve(true);
      },
      persisted: () => Promise.resolve(persisted),
    };
    const { library: sessions } = library(new FakeDirectory(), storage);

    expect(await sessions.estimate()).toEqual({ usage: 2048, quota: 1 << 30, persisted: false });
    expect(await sessions.persist()).toBe(true);
    expect(await sessions.estimate()).toMatchObject({ persisted: true });
    expect(await library().library.estimate()).toBeNull();
  });
});

describe('the message transport', () => {
  test('carries requests to a host over a message port and errors back with their names', async () => {
    const channel = new MessageChannel();
    const host = new OpfsHost(() => Promise.resolve(new FakeDirectory()));
    channel.port2.addEventListener('message', (event: MessageEvent<unknown>) => {
      if (isHostRequest(event.data)) {
        void host
          .handle(event.data)
          .then((response: HostResponse) => channel.port2.postMessage(response));
      }
    });
    channel.port2.start();
    channel.port1.start();
    const sessions = new OpfsSessionLibrary(new MessageTransport(() => channel.port1));

    const { info, file } = await sessions.create(NEW_SESSION);
    await file.write(0, new Uint8Array([3, 1, 4]));
    expect(await file.read(0, 3)).toEqual(new Uint8Array([3, 1, 4]));
    expect((await sessions.list()).map((session) => session.id)).toEqual([info.id]);
    await expect(sessions.open('missing')).rejects.toMatchObject({ name: 'NotFoundError' });
    channel.port1.close();
  });
});

type Listener = ((event: MessageEvent<unknown>) => void) | ((event: Event) => void);

class HostWorker implements MessageTarget {
  readonly #host: OpfsHost;
  readonly #listeners: { readonly type: string; readonly listener: Listener }[] = [];
  silent = false;
  terminated = false;

  constructor(root: FakeDirectory) {
    this.#host = new OpfsHost(() => Promise.resolve(root));
  }

  postMessage(message: unknown): void {
    if (this.silent || this.terminated || !isHostRequest(message)) {
      return;
    }

    void this.#host.handle(structuredClone(message)).then((response) => {
      if (!this.terminated) {
        this.#dispatch(new MessageEvent('message', { data: structuredClone(response) }));
      }
    });
  }

  addEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void;
  addEventListener(type: 'error', listener: (event: Event) => void): void;
  addEventListener(type: 'message' | 'error', listener: Listener): void {
    this.#listeners.push({ type, listener });
  }

  fail(): void {
    this.#dispatch(new MessageEvent('error'));
  }

  terminate(): void {
    this.terminated = true;
  }

  #dispatch(event: MessageEvent<unknown>): void {
    for (const { type, listener } of this.#listeners) {
      if (type === event.type) {
        listener(event);
      }
    }
  }
}

function workers(root = new FakeDirectory()) {
  const started: HostWorker[] = [];
  const transport = new MessageTransport(() => {
    const worker = new HostWorker(root);
    started.push(worker);
    return worker;
  }, 200);
  return { started, sessions: new OpfsSessionLibrary(transport), transport };
}

describe('the message transport to a worker that dies', () => {
  test('fails what waits on a worker that reports an error, and starts another', async () => {
    const { started, sessions } = workers();
    await sessions.list();
    started[0].silent = true;
    const waiting = sessions.list();
    started[0].fail();

    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
    expect(started[0].terminated).toBe(true);
    expect(await sessions.list()).toEqual([]);
    expect(started).toHaveLength(2);
  });

  test('takes a worker that never answers for dead after the timeout', async () => {
    const { started, sessions, transport } = workers();
    await sessions.list();
    started[0].silent = true;

    await expect(sessions.list()).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(started[0].terminated).toBe(true);
    expect(transport.generation).toBe(1);
    expect(await sessions.list()).toEqual([]);
  });

  test('opens a file again in the new worker, so a recording carries on', async () => {
    const root = new FakeDirectory();
    const { started, sessions } = workers(root);
    const { info, file } = await sessions.create(NEW_SESSION);
    await file.write(0, new Uint8Array([1, 2]));
    started[0].silent = true;
    await expect(file.write(2, new Uint8Array([3]))).rejects.toMatchObject({
      name: 'TimeoutError',
    });
    recordingOf(root, info.id).locked = false;

    await file.write(2, new Uint8Array([3, 4]));
    expect(await file.read(0, 4)).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(started).toHaveLength(2);
  });
});
