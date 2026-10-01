import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import type { Variable } from '@/core/variables';
import { TelemetryStore, ManualScheduler } from '@/telemetry';

import { MessageTransport, OpfsSessionLibrary } from '@/app/sessions/opfs-library';
import { MemoryLocks, WebLocks } from '@/app/sessions/session-library';
import { SessionManager } from '@/app/sessions/session-manager';

const SAMPLE_US = 10_000;
const VARIABLES: readonly Variable[] = [
  {
    id: 0,
    name: 'pose/x',
    type: 'f32',
    access: { stream: true, write: false, writeNeedsIdle: false, persists: false },
  },
];

const workers: Worker[] = [];

function storageWorker(): Worker {
  const worker = new Worker(new URL('../../../src/app/sessions/opfs.worker.ts', import.meta.url), {
    type: 'module',
  });
  workers.push(worker);
  return worker;
}

function tab(clock: { ms: number }) {
  const worker = storageWorker();
  const scheduler = new ManualScheduler();
  const store = new TelemetryStore({ scheduler, now: () => clock.ms });
  store.setSchema(VARIABLES);
  store.openEpoch({
    epochId: 1,
    groupId: 0,
    variables: [{ id: 0, type: 'f32' }],
  });
  const manager = new SessionManager({
    store,
    library: new OpfsSessionLibrary(new MessageTransport(() => worker), navigator.storage),
    locks: new MemoryLocks(),
    scheduler,
    now: () => clock.ms,
    describe: () => ({
      name: 'micras',
      robot: { name: 'micras' },
      schema: VARIABLES,
    }),
  });
  return { worker, store, manager };
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function stream(
  store: TelemetryStore,
  clock: { ms: number },
  from: number,
  to: number
): Promise<void> {
  const end = Math.min(to, from + 10);

  for (let index = from; index < end; index++) {
    store.append(1, index * SAMPLE_US, [Math.sin(index / 40)]);
  }

  clock.ms += 100;
  await pause(0);

  if (end < to) {
    await stream(store, clock, end, to);
  }
}

async function until(condition: () => boolean, deadline = performance.now() + 5000): Promise<void> {
  if (condition()) {
    return;
  }

  if (performance.now() > deadline) {
    throw new Error('Timed out');
  }

  await pause(10);
  await until(condition, deadline);
}

async function clearStorage(): Promise<void> {
  const root = await navigator.storage.getDirectory();
  await root.removeEntry('micras-monitor', { recursive: true }).catch(() => undefined);
}

beforeEach(clearStorage);

afterEach(async () => {
  workers.splice(0).forEach((worker) => worker.terminate());
  await clearStorage();
});

describe('sessions in the Origin Private File System of Chromium', () => {
  test('recovers a recording whose worker died with its file open, losing at most the last flush', async () => {
    const clock = { ms: Date.UTC(2026, 8, 29, 12) };
    const first = tab(clock);
    await first.manager.start();
    await stream(first.store, clock, 0, 800);
    await first.manager.startRecording();
    await stream(first.store, clock, 800, 3100);
    await until(() => (first.manager.state.recording?.stats.samples ?? 0) >= 2700);
    const written = first.manager.state.recording!.stats.samples;
    const id = first.manager.state.recording!.session.id;
    first.worker.terminate();

    const second = tab(clock);
    await second.manager.start();
    const [recovered] = second.manager.state.recovered;

    expect(recovered.session).toMatchObject({ id, state: 'saved' });
    expect(recovered.session.samples).toBeGreaterThanOrEqual(written);
    expect(recovered.recovery).toMatchObject({ truncatedBytes: 0, damagedRecords: 0 });
    await second.manager.open(id);
    const viewing = second.manager.state.viewing!;
    const lostUs = first.store.timeRange()!.endUs - viewing.store.timeRange()!.endUs;

    expect(viewing.store.timeRange()!.startUs).toBe(0);
    expect(lostUs).toBeLessThanOrEqual(5_000_000);
    expect(viewing.store.valueAt('pose/x', 1234 * SAMPLE_US)).toEqual({
      value: Math.fround(Math.sin(1234 / 40)),
      timeUs: 1234 * SAMPLE_US,
    });
  });

  test('keeps a finished session across workers, and exports, renames and deletes it', async () => {
    const clock = { ms: Date.UTC(2026, 8, 29, 13) };
    const first = tab(clock);
    await first.manager.start();
    await first.manager.startRecording();
    await stream(first.store, clock, 0, 500);
    await first.manager.stopRecording();
    await first.manager.resetLive();
    const [saved] = first.manager.state.sessions;
    first.worker.terminate();

    const second = tab(clock);
    await second.manager.start();

    expect(second.manager.state.recovered).toEqual([]);
    expect(second.manager.state.sessions).toEqual([saved]);
    await second.manager.rename(saved.id, 'Bench');
    const exported = await second.manager.exportSession(saved.id);

    expect(exported?.fileName).toBe('bench.mmrec');
    expect(exported?.blob.size).toBeGreaterThan(saved.bytes - 64);
    await second.manager.remove(saved.id);
    expect(second.manager.state.sessions).toEqual([]);
    expect(second.manager.state.error).toBeNull();
  });

  test('tells a tab that holds a recording lock from one that died, through Web Locks', async () => {
    const locks = new WebLocks(navigator.locks);
    const release = await locks.hold('session-a');

    expect(await locks.held('session-a')).toBe(true);
    expect(await locks.held('session-b')).toBe(false);
    release();
    await until(() => true);
    expect(await locks.held('session-a')).toBe(false);
  });

  test('holds a session lock for the whole task, and skips a session another tab holds', async () => {
    const locks = new WebLocks(navigator.locks);
    let inside = false;
    const ran = await locks.runIfFree('session-c', async () => {
      inside = await locks.held('session-c');
      return Promise.resolve('done');
    });

    expect(ran).toEqual({ value: 'done' });
    expect(inside).toBe(true);
    const release = await locks.hold('session-d');
    expect(await locks.runIfFree('session-d', () => Promise.resolve(1))).toBeNull();
    release();
  });
});
