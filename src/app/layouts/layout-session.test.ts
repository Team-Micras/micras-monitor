import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { TypeCode, decodeAccess } from '@/protocol';
import type { LayoutPreset, SchemaVariable } from '@/robot-kit';
import { activeWorkspace, leafIds } from '@/tiling';

import { createShellStore, type ShellStore } from '../state/shell-store';
import { LayoutBook, STORAGE_PREFIX } from './layout-book';
import { LayoutSession, SAVE_DELAY_MS, type LayoutSubject } from './layout-session';
import { MemoryStorage } from './memory-storage';

const STREAM = decodeAccess(0x01);

function schema(...variableNames: string[]): SchemaVariable[] {
  return variableNames.map((name) => ({ name, type: TypeCode.F32, access: STREAM, typeTag: null }));
}

function subject(
  key: string,
  variableNames: string[],
  packagePresets: LayoutPreset[] = []
): LayoutSubject {
  return { key, variables: schema(...variableNames), packagePresets };
}

const PRESETS: LayoutPreset[] = [
  {
    name: 'Tracking',
    root: { window: { kind: 'plot', title: 'Speed', variables: ['pose/v'] } },
  },
  { name: 'Sensors', root: { window: { kind: 'readouts', variables: ['wall/0'] } } },
];

let storage: MemoryStorage;
let store: ShellStore;
let session: LayoutSession;

function workspaceNames(shell: ShellStore): string[] {
  return shell.getState().desktop.workspaces.map((workspace) => workspace.name);
}

beforeEach(() => {
  vi.useFakeTimers();
  storage = new MemoryStorage();
  store = createShellStore();
  session = new LayoutSession(store, new LayoutBook(storage));
});

afterEach(() => {
  session.stop();
  vi.useRealTimers();
});

describe('the layout of a robot that connects for the first time', () => {
  test('is an automatic layout from its schema in raw mode', () => {
    session.follow(subject('name:rover', ['pose/x', 'pose/y']));
    expect(workspaceNames(store)).toEqual(['Overview', 'Pose']);
    expect(store.getState().paused.size).toBe(0);
  });

  test('is the presets of its package, one workspace each, when it has some', () => {
    session.follow(subject('package:micras', ['pose/v'], PRESETS));
    expect(workspaceNames(store)).toEqual(['Tracking', 'Sensors']);
    expect(store.getState().desktop.active).toBe(0);
  });

  test('is saved at once, so that a reload finds it', () => {
    session.follow(subject('name:rover', ['pose/x']));
    expect(storage.getItem(`${STORAGE_PREFIX}name:rover`)).not.toBeNull();
  });
});

function savedNames(): string[] | undefined {
  return new LayoutBook(storage).load('name:rover', [])?.desktop?.workspaces.map((ws) => ws.name);
}

describe('saving', () => {
  test('waits for changes to stop, and saves the last one', () => {
    session.follow(subject('name:rover', ['pose/x']));
    store.getState().addWorkspace();
    vi.advanceTimersByTime(SAVE_DELAY_MS - 1);
    store.getState().addWorkspace();
    vi.advanceTimersByTime(SAVE_DELAY_MS - 1);
    expect(savedNames()).toEqual(['Overview', 'Pose']);

    vi.advanceTimersByTime(1);
    expect(savedNames()).toEqual(['Overview', 'Pose', 'Workspace 3', 'Workspace 4']);
  });

  test('saves the presets the user makes with the layout', () => {
    session.follow(subject('name:rover', ['pose/x']));
    store.getState().savePreset('Mine');
    vi.advanceTimersByTime(SAVE_DELAY_MS);
    expect(new LayoutBook(storage).load('name:rover', [])?.presets.map((p) => p.name)).toEqual([
      'Mine',
    ]);
  });

  test('flushes what waits when asked, and when the session stops', () => {
    session.follow(subject('name:rover', ['pose/x']));
    store.getState().addWorkspace();
    session.flush();
    expect(new LayoutBook(storage).load('name:rover', [])?.desktop?.workspaces).toHaveLength(3);

    store.getState().addWorkspace();
    session.stop();
    expect(new LayoutBook(storage).load('name:rover', [])?.desktop?.workspaces).toHaveLength(4);
    vi.advanceTimersByTime(SAVE_DELAY_MS * 2);
    store.getState().addWorkspace();
    vi.advanceTimersByTime(SAVE_DELAY_MS * 2);
    expect(new LayoutBook(storage).load('name:rover', [])?.desktop?.workspaces).toHaveLength(4);
  });
});

describe('following robots', () => {
  test('restores the layout a robot had after a reload', () => {
    session.follow(subject('name:rover', ['pose/x']));
    store.getState().run({ type: 'switchWorkspace', index: 1 });
    store.getState().addWorkspace();
    session.stop();

    const reloaded = createShellStore();
    new LayoutSession(reloaded, new LayoutBook(storage)).follow(subject('name:rover', ['pose/x']));
    expect(workspaceNames(reloaded)).toEqual(['Overview', 'Pose', 'Workspace 3']);
    expect(reloaded.getState().desktop.active).toBe(2);
  });

  test('keeps the layout when the same robot links again, or its schema gains a variable', () => {
    session.follow(subject('name:rover', ['pose/x']));
    store.getState().addWorkspace();
    const before = store.getState().desktop;
    session.follow(subject('name:rover', ['pose/x', 'pose/y']));
    session.follow(subject('name:rover', ['pose/x']));
    expect(store.getState().desktop).toBe(before);
  });

  test('switches to the layout of another robot, saving the one it leaves', () => {
    session.follow(subject('name:rover', ['pose/x']));
    store.getState().addWorkspace();
    session.follow(subject('name:crawler', ['leg/a']));
    expect(workspaceNames(store)).toEqual(['Overview', 'Leg']);
    store.getState().addWorkspace();
    store.getState().addWorkspace();

    session.follow(subject('name:rover', ['pose/x']));
    expect(workspaceNames(store)).toEqual(['Overview', 'Pose', 'Workspace 3']);
    session.follow(subject('name:crawler', ['leg/a']));
    expect(workspaceNames(store)).toEqual(['Overview', 'Leg', 'Workspace 3', 'Workspace 4']);
  });

  test('brings the user presets of a robot along with its layout', () => {
    session.follow(subject('name:rover', ['pose/x']));
    store.getState().savePreset('Mine');
    session.follow(subject('name:crawler', ['leg/a']));
    expect(store.getState().presets).toEqual([]);
    session.follow(subject('name:rover', ['pose/x']));
    expect(store.getState().presets.map((preset) => preset.name)).toEqual(['Mine']);
  });

  test('uses a saved layout over the package presets, and the presets once it is corrupt', () => {
    session.follow(subject('package:micras', ['pose/v'], PRESETS));
    store.getState().run({ type: 'renameWorkspace', index: 0, name: 'Mine' });
    session.stop();

    session.follow(subject('package:micras', ['pose/v'], PRESETS));
    expect(workspaceNames(store)).toEqual(['Mine', 'Sensors']);
    session.stop();

    storage.setItem(`${STORAGE_PREFIX}package:micras`, '{oops');
    session.follow(subject('package:micras', ['pose/v'], PRESETS));
    expect(workspaceNames(store)).toEqual(['Tracking', 'Sensors']);
  });

  test('keeps a layout with variables the schema no longer has', () => {
    session.follow(subject('name:rover', ['pose/x', 'pose/y']));
    session.stop();
    session.follow(subject('name:rover', ['pose/x']));
    const plot = [...store.getState().desktop.windows.values()].find((w) => w.kind === 'plot');
    expect(plot?.payload.variables).toEqual(['pose/x', 'pose/y']);
    expect(leafIds(activeWorkspace(store.getState().desktop).root)).toHaveLength(2);
  });
});
