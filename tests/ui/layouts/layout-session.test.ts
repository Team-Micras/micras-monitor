import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import type { Variable } from '@/core/variables';
import type { LayoutPreset } from '@/core/robot';
import { activeWorkspace, leafIds } from '@/tiling';

import { createShellStore, type ShellStore } from '@/ui/state/shell-store';
import {
  BACKUP_PREFIX,
  LayoutBook,
  RECORD_VERSION,
  STORAGE_PREFIX,
} from '@/ui/layouts/saved-layouts';
import { LayoutSession, SAVE_DELAY_MS, type LayoutSubject } from '@/ui/layouts/layout-session';
import { MemoryStorage } from '@tests/support/ui/layouts/memory-storage';

const STREAM = { stream: true, write: false, writeNeedsIdle: false, persists: false };

function schema(...variableNames: string[]): Variable[] {
  return variableNames.map((name, id): Variable => ({ id, name, type: 'f32', access: STREAM }));
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

function reopened(): { shell: ShellStore; next: LayoutSession } {
  const shell = createShellStore();
  const next = new LayoutSession(shell, new LayoutBook(storage));
  next.start();
  return { shell, next };
}

describe('before the first link', () => {
  test('shows the layout of the robot shown last', () => {
    session.follow(subject('name:rover', ['pose/x']));
    store.getState().addWorkspace();
    session.stop();

    const { shell } = reopened();
    expect(workspaceNames(shell)).toEqual(['Overview', 'Pose', 'Workspace 3']);
  });

  test('shows the default desktop when no robot was shown before', () => {
    const { shell } = reopened();
    expect(workspaceNames(shell)).toEqual(workspaceNames(createShellStore()));
  });

  test('keeps what the user edited for the robot that links first, and the presets made', () => {
    const { shell, next } = reopened();
    shell.getState().addWorkspace();
    shell.getState().savePreset('Mine');
    const edited = shell.getState().desktop;
    next.follow(subject('name:rover', ['pose/x']));
    expect(shell.getState().desktop).toBe(edited);
    expect(shell.getState().presets.map((preset) => preset.name)).toEqual(['Mine']);
    expect(new LayoutBook(storage).load('name:rover', [])?.presets).toHaveLength(1);
  });

  test('keeps the edits made to the layout shown last when that robot links, and saves them', () => {
    session.follow(subject('name:rover', ['pose/x']));
    store.getState().savePreset('Old');
    session.stop();

    const { shell, next } = reopened();
    shell.getState().addWorkspace();
    shell.getState().deletePreset('Old');
    shell.getState().savePreset('Mine');
    const edited = shell.getState().desktop;
    next.follow(subject('name:rover', ['pose/x']));
    expect(shell.getState().desktop).toBe(edited);
    next.flush();
    const saved = new LayoutBook(storage).load('name:rover', []);
    expect(saved?.desktop?.workspaces).toHaveLength(3);
    expect(saved?.presets.map((preset) => preset.name)).toEqual(['Mine']);
  });

  test('saves the edits for the last robot when another links, which starts from its own layout', () => {
    session.follow(subject('name:rover', ['pose/x']));
    store.getState().savePreset('Rover only');
    session.stop();

    const { shell, next } = reopened();
    shell.getState().addWorkspace();
    shell.getState().savePreset('Made since');
    next.follow(subject('name:crawler', ['leg/a']));
    expect(workspaceNames(shell)).toEqual(['Overview', 'Leg']);
    expect(shell.getState().presets.map((preset) => preset.name)).toEqual(['Made since']);

    const rover = new LayoutBook(storage).load('name:rover', []);
    expect(rover?.desktop?.workspaces).toHaveLength(3);
    expect(rover?.presets.map((preset) => preset.name)).toEqual(['Rover only', 'Made since']);
  });

  test('does not carry the presets of the last robot to another that links first', () => {
    session.follow(subject('name:rover', ['pose/x']));
    store.getState().savePreset('Rover only');
    session.stop();

    const { shell, next } = reopened();
    next.follow(subject('name:crawler', ['leg/a']));
    expect(shell.getState().presets).toEqual([]);
    expect(workspaceNames(shell)).toEqual(['Overview', 'Leg']);
  });
});

describe('a saved entry that cannot be read', () => {
  const NEWER = JSON.stringify({ version: RECORD_VERSION + 1, desktop: 'from the future' });

  test('is left as it is until the user changes something', () => {
    storage.setItem(`${STORAGE_PREFIX}name:rover`, NEWER);
    session.follow(subject('name:rover', ['pose/x']));
    session.flush();
    session.stop();
    expect(storage.getItem(`${STORAGE_PREFIX}name:rover`)).toBe(NEWER);
    expect(storage.getItem(`${BACKUP_PREFIX}name:rover`)).toBeNull();
    expect(workspaceNames(store)).toEqual(['Overview', 'Pose']);
  });

  test('is copied aside before the first edit replaces it', () => {
    storage.setItem(`${STORAGE_PREFIX}name:rover`, NEWER);
    session.follow(subject('name:rover', ['pose/x']));
    store.getState().addWorkspace();
    vi.advanceTimersByTime(SAVE_DELAY_MS);
    expect(storage.getItem(`${BACKUP_PREFIX}name:rover`)).toBe(NEWER);
    expect(new LayoutBook(storage).load('name:rover', [])?.desktop?.workspaces).toHaveLength(3);
  });
});
