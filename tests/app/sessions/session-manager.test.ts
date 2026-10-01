import { describe, expect, test } from 'vitest';

import { TypeCode, decodeAccess } from '@/protocol';
import { MemoryRecordingFile, SavedRecording, TelemetryStore } from '@/telemetry';

import { DirectTransport, FakeDirectory, FakeFile } from '@tests/support/app/sessions/fake-opfs';
import { MemorySessionLibrary } from '@/app/sessions/memory-library';
import { OpfsSessionLibrary } from '@/app/sessions/opfs-library';
import { MemoryLocks, type SessionLibrary } from '@/app/sessions/session-library';
import {
  defaultSessionName,
  exportFileName,
  recordedSchema,
  schemaVariables,
  SessionManager,
  type SessionsState,
} from '@/app/sessions/session-manager';
import { ManualScheduler } from '@tests/support/telemetry/manual-scheduler';
import { deserializeRecording } from '@tests/support/telemetry/recording-bytes';

const SAMPLE_US = 10_000;
const VARIABLES = [
  { id: 0, name: 'pose/x', type: TypeCode.F32, access: decodeAccess(0x01), typeTag: null },
  { id: 1, name: 'maze', type: TypeCode.BLOB, access: decodeAccess(0x08), typeTag: 'maze-grid' },
];

function settle(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

function rig(
  library: SessionLibrary = new MemorySessionLibrary(() => 5),
  locks = new MemoryLocks()
) {
  const clock = { ms: Date.UTC(2026, 8, 29, 10, 42) };
  const scheduler = new ManualScheduler();
  const store = new TelemetryStore({ scheduler, now: () => clock.ms });
  store.setSchema(VARIABLES);
  store.openEpoch({
    epochId: 1,
    groupId: 0,
    variables: [{ id: 0, type: TypeCode.F32 }],
    firstSequence: 0,
  });
  const manager = new SessionManager({
    store,
    library,
    locks,
    scheduler,
    now: () => clock.ms,
    describe: () => ({
      name: 'micras',
      robot: { name: 'micras', schemaHash: 0x9f1c },
      schema: recordedSchema(VARIABLES),
    }),
  });
  let next = 0;
  const stream = (seconds: number) =>
    each(seconds, async () => {
      for (let sample = 0; sample < 100; sample++) {
        store.append(1, next & 0xffff, next * SAMPLE_US, [Math.sin(next / 50)]);
        next++;
      }

      clock.ms += 1000;
      await settle();
    });
  return { store, manager, library, locks, scheduler, clock, stream, streamed: () => next };
}

async function each(count: number, step: () => Promise<void>): Promise<void> {
  if (count > 0) {
    await step();
    await each(count - 1, step);
  }
}

function recordingState(state: SessionsState) {
  if (!state.recording) {
    throw new Error('Not recording');
  }

  return state.recording;
}

describe('recording the live session', () => {
  test('backfills the session, records as it grows, and saves it with its size and length', async () => {
    const { store, manager, stream } = rig();
    await manager.start();
    await stream(3);
    await manager.startRecording();
    const recording = recordingState(manager.state);

    expect(recording.session).toMatchObject({ state: 'recording', robot: 'micras' });
    expect(manager.state.sessions.map((session) => session.id)).toEqual([recording.session.id]);
    await stream(7);
    expect(manager.state.recording?.stats.samples).toBeGreaterThan(300);
    await manager.stopRecording();

    expect(manager.state.recording).toBeNull();
    const [saved] = manager.state.sessions;
    expect(saved).toMatchObject({ state: 'saved', samples: 1000 });
    expect(saved.durationUs).toBe(store.timeRange()!.endUs - store.timeRange()!.startUs);
    expect(saved.bytes).toBeGreaterThan(1000 * 12);
    expect(manager.state.liveSources).toEqual([saved.id]);
  });

  test('writes the last samples before the stream goes quiet, once the flush interval passes', async () => {
    const { manager, clock, stream } = rig();
    await manager.start();
    await manager.startRecording();
    await stream(1);
    clock.ms += 5000;

    await expect
      .poll(() => manager.state.recording?.stats.samples, { timeout: 3000, interval: 100 })
      .toBe(100);
    await manager.stopRecording();
  });

  test('holds the lock of a session before its description says it is recording', async () => {
    const locks = new MemoryLocks();
    const library = new MemorySessionLibrary();
    const create = library.create.bind(library);
    const heldAtCreate: boolean[] = [];
    library.create = async (info) => {
      heldAtCreate.push(await locks.held(info.id));
      return create(info);
    };
    const { manager } = rig(library, locks);
    await manager.start();
    await manager.startRecording();

    expect(heldAtCreate).toEqual([true]);
  });

  test('keeps the lock of a session it could not mark saved, so no other tab takes it', async () => {
    const locks = new MemoryLocks();
    const library = new MemorySessionLibrary();
    const { manager, stream } = rig(library, locks);
    await manager.start();
    await manager.startRecording();
    await stream(1);
    const { id } = recordingState(manager.state).session;
    library.update = () => Promise.reject(new DOMException('full', 'QuotaExceededError'));
    await manager.stopRecording();

    expect(manager.state.error).toMatch(/did not end cleanly: full/);
    expect(await locks.held(id)).toBe(true);
    expect(manager.state.sessions[0].state).toBe('recording');
  });

  test('says why recording could not write, and keeps going once it can', async () => {
    const root = new FakeDirectory();
    const library = new OpfsSessionLibrary(new DirectTransport(root));
    const { store, manager, stream } = rig(library);
    await manager.start();
    await manager.startRecording();
    const { id } = recordingState(manager.state).session;
    const file = root.at('micras-monitor', 'sessions', id, 'recording.mmrec');

    if (!(file instanceof FakeFile)) {
      throw new Error('No recording file');
    }

    file.room = 0;
    await stream(6);

    expect(manager.state.error).toMatch(/Recording could not write: Wrote 0 of \d+ bytes/);
    expect(store.status().persistenceFailing).toBe(true);
    expect(manager.state.recording?.stats.failing).toBe(true);

    file.room = Number.POSITIVE_INFINITY;
    await stream(12);
    expect(manager.state.recording?.stats.failing).toBe(false);
    expect(store.status().persistenceFailing).toBe(false);
  });

  test('renames the session being recorded and exports it under that name', async () => {
    const { manager, stream } = rig();
    await manager.start();
    await manager.startRecording();
    await stream(6);
    const { id } = recordingState(manager.state).session;
    await manager.rename(id, '  Final run  ');

    expect(manager.state.recording?.session.name).toBe('Final run');
    const exported = await manager.exportSession(id);
    const read = deserializeRecording(new Uint8Array(await exported!.blob.arrayBuffer()));

    expect(exported?.fileName).toBe('final-run.mmrec');
    expect(read.header.name).toBe('Final run');
    expect(read.header.schema).toEqual(recordedSchema(VARIABLES));
    expect(read.records.some((record) => record.kind === 'block')).toBe(true);
  });

  test('keeps the sessions the live store reads from until the live session is reset', async () => {
    const { store, manager, library, stream } = rig();
    await manager.start();
    await manager.startRecording();
    await stream(2);
    await manager.stopRecording();
    const [saved] = manager.state.sessions;
    await manager.remove(saved.id);

    expect(manager.state.error).toMatch(/reset it first/);
    expect(manager.state.sessions).toHaveLength(1);

    await manager.resetLive();
    expect(store.timeRange()).toBeUndefined();
    expect(manager.state.liveSources).toEqual([]);
    expect(library instanceof MemorySessionLibrary && library.openings(saved.id)).toBe(0);
    await manager.remove(saved.id);
    expect(manager.state.sessions).toEqual([]);
  });

  test('ends the recording when the live session is reset', async () => {
    const { manager, stream } = rig();
    await manager.start();
    await manager.startRecording();
    await stream(2);
    await manager.resetLive();

    expect(manager.state.recording).toBeNull();
    expect(manager.state.sessions[0]).toMatchObject({ state: 'saved', samples: 200 });
  });
});

describe('opening a saved session', () => {
  test('loads it read only beside the live store, which carries on', async () => {
    const { store, manager, stream } = rig();
    await manager.start();
    await manager.startRecording();
    await stream(4);
    await manager.stopRecording();
    const [saved] = manager.state.sessions;
    await manager.open(saved.id);
    const viewing = manager.state.viewing;

    expect(viewing?.session.id).toBe(saved.id);
    expect(viewing?.robot).toBe('micras');
    expect(viewing?.variables).toEqual(schemaVariables(recordedSchema(VARIABLES)));
    expect(viewing?.store.timeRange()).toEqual(store.timeRange());
    expect(viewing?.summary).toMatchObject({ samples: 400, damaged: [] });
    expect(viewing?.loadMs).toBeGreaterThanOrEqual(0);

    await stream(1);
    expect(viewing?.store.variable('pose/x')?.storedSamples).toBe(400);
    expect(store.variable('pose/x')?.storedSamples).toBe(500);

    await manager.backToLive();
    expect(manager.state.viewing).toBeNull();
  });

  test('gives the opened session what the live history leaves of the one memory cap', async () => {
    const { store, manager, stream } = rig();
    await manager.start();
    await manager.startRecording();
    await stream(4);
    await manager.stopRecording();
    const { usedBytes, capBytes } = store.status();
    await manager.open(manager.state.sessions[0].id);

    expect(manager.state.viewing?.store.status().capBytes).toBe(capBytes - usedBytes);
  });

  test('closes the session on screen when it is deleted', async () => {
    const { manager, stream } = rig();
    await manager.start();
    await manager.startRecording();
    await stream(1);
    await manager.resetLive();
    const [saved] = manager.state.sessions;
    await manager.open(saved.id);
    await manager.remove(saved.id);

    expect(manager.state.viewing).toBeNull();
    expect(manager.state.sessions).toEqual([]);
  });

  test('says why a session that is not a recording does not open', async () => {
    const library = new MemorySessionLibrary();
    library.seed(
      {
        id: 'broken',
        name: 'broken',
        robot: null,
        createdAtMs: 1,
        updatedAtMs: 1,
        state: 'saved',
        bytes: 4,
        samples: 0,
        durationUs: 0,
      },
      new Uint8Array([1, 2, 3, 4])
    );
    const { manager } = rig(library);
    await manager.start();
    await manager.open('broken');

    expect(manager.state.viewing).toBeNull();
    expect(manager.state.error).toMatch(/Could not open the session: Not a monitor recording/);
    expect(library.openings('broken')).toBe(0);
  });
});

async function recordThenDie(seconds: number) {
  const root = new FakeDirectory();
  const transport = new DirectTransport(root);
  const first = rig(new OpfsSessionLibrary(transport));
  await first.manager.start();
  await first.manager.startRecording();
  await first.stream(seconds);
  const { id } = recordingState(first.manager.state).session;
  transport.crash();
  const after = rig(new OpfsSessionLibrary(new DirectTransport(root)));
  return { root, id, first, after };
}

describe('recovering after the tab died', () => {
  test('recovers a session whose description was lost, from its recording', async () => {
    const { root, id, after } = await recordThenDie(8);
    const folder = root.at('micras-monitor', 'sessions', id);

    if (!(folder instanceof FakeDirectory)) {
      throw new Error('No session folder');
    }

    folder.entries.delete('session.json');
    folder.entries.delete('session.next.json');
    await after.manager.start();

    expect(after.manager.state.error).toBeNull();
    expect(after.manager.state.recovered[0].session).toMatchObject({
      id,
      state: 'saved',
      robot: 'micras',
      name: expect.stringMatching(/^micras · /),
    });
    const again = rig(new OpfsSessionLibrary(new DirectTransport(root)));
    await again.manager.start();

    expect(again.manager.state).toMatchObject({ error: null, recovered: [] });
    expect(again.manager.state.sessions.map((session) => session.state)).toEqual(['saved']);
  });

  test('lists every session even when one of them cannot be recovered', async () => {
    const root = new FakeDirectory();
    const saver = rig(new OpfsSessionLibrary(new DirectTransport(root)));
    await saver.manager.start();
    await saver.manager.startRecording();
    await saver.stream(3);
    await saver.manager.stopRecording();
    const elsewhere = new OpfsSessionLibrary(new DirectTransport(root));
    await elsewhere.create({
      id: 'held-elsewhere',
      name: 'held elsewhere',
      robot: null,
      createdAtMs: Date.UTC(2026, 8, 29, 11),
      state: 'recording',
      bytes: 0,
      samples: 0,
      durationUs: 0,
    });
    const tab = rig(new OpfsSessionLibrary(new DirectTransport(root)));
    await tab.manager.start();

    expect(tab.manager.state.ready).toBe(true);
    expect(tab.manager.state.error).toMatch(/Could not recover held elsewhere/);
    expect(tab.manager.state.sessions.map((session) => session.name).toSorted()).toEqual(
      ['held elsewhere', saver.manager.state.sessions[0].name].toSorted()
    );
  });

  test('recovers the recording with nothing lost beyond the last flush', async () => {
    const { id, first, after } = await recordThenDie(23);
    await after.manager.start();

    const [recovered] = after.manager.state.recovered;
    expect(recovered.session).toMatchObject({ id, state: 'saved' });
    expect(recovered.recovery).toMatchObject({ truncatedBytes: 0, damagedRecords: 0 });
    await after.manager.open(id);
    const reopened = after.manager.state.viewing?.store;
    const lostUs = first.store.timeRange()!.endUs - reopened!.timeRange()!.endUs;

    expect(reopened?.timeRange()?.startUs).toBe(0);
    expect(lostUs).toBeLessThanOrEqual(5_000_000);
    expect(reopened?.variable('pose/x')?.storedSamples).toBe(recovered.session.samples);
    expect(recovered.session.samples).toBeGreaterThanOrEqual(first.streamed() - 500);
  });

  test('cuts a damaged tail from the file and reports it', async () => {
    const { root, id, after } = await recordThenDie(12);
    const file = root.at('micras-monitor', 'sessions', id, 'recording.mmrec');

    if (!(file instanceof FakeFile)) {
      throw new Error('No recording file');
    }

    const whole = file.bytes.byteLength;
    const cut = new Uint8Array(whole + 30);
    cut.set(file.bytes);
    cut.set([2, 0, 0, 0, 0xff, 0xff, 0, 0], whole);
    file.bytes = cut;
    await after.manager.start();

    expect(after.manager.state.recovered[0].recovery.truncatedBytes).toBe(30);
    expect(file.bytes.byteLength).toBe(whole);
    const saved = await SavedRecording.read(new MemoryRecordingFile(file.bytes));
    expect(saved.summary.truncatedAt).toBeUndefined();
  });

  test('leaves alone a session another tab is recording', async () => {
    const root = new FakeDirectory();
    const locks = new MemoryLocks();
    const first = rig(new OpfsSessionLibrary(new DirectTransport(root)), locks);
    await first.manager.start();
    await first.manager.startRecording();
    const other = rig(new OpfsSessionLibrary(new DirectTransport(root)), locks);
    await other.manager.start();

    expect(other.manager.state.recovered).toEqual([]);
    expect(other.manager.state.sessions[0].state).toBe('recording');
  });

  test('lets one of two tabs starting together recover a session, the other skipping it quietly', async () => {
    const source = new MemorySessionLibrary(() => 5);
    const saver = rig(source);
    await saver.manager.start();
    await saver.manager.startRecording();
    await saver.stream(3);
    const { id } = recordingState(saver.manager.state).session;
    const dead = new MemorySessionLibrary(() => 5);
    const [info] = await source.list();
    dead.seed(info, source.contents(id));

    const open = dead.open.bind(dead);
    let openings = 0;
    const release = { open: () => undefined as void };
    const gate = new Promise<void>((resolve) => {
      release.open = resolve;
    });
    dead.open = async (session) => {
      openings++;
      await gate;
      return open(session);
    };
    const locks = new MemoryLocks();
    const first = rig(dead, locks);
    const second = rig(dead, locks);
    const starting = first.manager.start();
    await settle();
    await second.manager.start();

    expect(second.manager.state.error).toBeNull();
    expect(second.manager.state.recovered).toEqual([]);
    release.open();
    await starting;

    expect(openings).toBe(1);
    expect(first.manager.state.error).toBeNull();
    expect(first.manager.state.recovered).toHaveLength(1);
    await second.manager.refresh();
    expect(second.manager.state.sessions[0].state).toBe('saved');
  });

  test('drops a session whose tab died before its header was written', async () => {
    const library = new MemorySessionLibrary();
    library.seed(
      {
        id: 'empty',
        name: 'empty',
        robot: null,
        createdAtMs: 1,
        updatedAtMs: 1,
        state: 'recording',
        bytes: 0,
        samples: 0,
        durationUs: 0,
      },
      new Uint8Array(0)
    );
    const { manager } = rig(library);
    await manager.start();

    expect(manager.state.sessions).toEqual([]);
    expect(manager.state.recovered).toEqual([]);
  });
});

test('tells about the memory cap nearing, dropping the oldest history, and pausing it', () => {
  const scheduler = new ManualScheduler();
  const store = new TelemetryStore({ scheduler, blockSize: 1024, memoryCapBytes: 200_000 });
  store.setSchema(VARIABLES);
  store.openEpoch({ epochId: 1, groupId: 0, variables: [{ id: 0, type: TypeCode.F32 }] });
  const manager = new SessionManager({
    store,
    library: new MemorySessionLibrary(),
    locks: new MemoryLocks(),
    scheduler,
    describe: () => ({ name: null, robot: {}, schema: [] }),
  });
  const kinds: string[] = [];
  manager.subscribe(() => kinds.push(manager.state.memory?.kind ?? 'none'));

  for (let index = 0; index < 40_000; index++) {
    store.append(1, index & 0xffff, index * SAMPLE_US, [index]);
  }

  expect(kinds).toContain('warning');
  expect(manager.state.memory).toMatchObject({ kind: 'dropped', capBytes: 200_000 });
  manager.dismissMemory();
  expect(manager.state.memory).toBeNull();
});

test('names sessions and their files', () => {
  expect(defaultSessionName('micras', Date.UTC(2026, 8, 29, 10, 42))).toMatch(/^micras · 29 Sep/);
  expect(defaultSessionName(null, 0)).toMatch(/^Session · /);
  expect(exportFileName('micras · 29 Sep, 10:42')).toBe('micras-29-sep-10-42.mmrec');
  expect(exportFileName('///')).toBe('session.mmrec');
});
