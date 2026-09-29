import { describe, expect, test } from 'vitest';

import { TypeCode, decodeAccess } from '@/protocol';
import {
  ManualScheduler,
  MemoryRecordingFile,
  SavedRecording,
  TelemetryStore,
  deserializeRecording,
} from '@/telemetry';

import { DirectTransport, FakeDirectory, FakeFile } from './fake-opfs';
import { MemorySessionLibrary } from './memory-library';
import { OpfsSessionLibrary } from './opfs-library';
import { MemoryLocks, type SessionLibrary } from './session-library';
import {
  defaultSessionName,
  exportFileName,
  recordedSchema,
  schemaVariables,
  SessionManager,
  type SessionsState,
} from './session-manager';

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
    each(seconds * 10, async () => {
      for (let sample = 0; sample < 10; sample++) {
        store.append(1, next & 0xffff, next * SAMPLE_US, [Math.sin(next / 50)]);
        next++;
      }

      clock.ms += 100;
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

test('names sessions and their files', () => {
  expect(defaultSessionName('micras', Date.UTC(2026, 8, 29, 10, 42))).toMatch(/^micras · 29 Sep/);
  expect(defaultSessionName(null, 0)).toMatch(/^Session · /);
  expect(exportFileName('micras · 29 Sep, 10:42')).toBe('micras-29-sep-10-42.mmrec');
  expect(exportFileName('///')).toBe('session.mmrec');
});
