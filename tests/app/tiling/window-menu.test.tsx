import { afterEach, describe, expect, test } from 'vitest';
import { userEvent } from 'vitest/browser';

import { createWorkspace, leaf, split } from '@/tiling';

import { settled } from '@tests/support/app/animations';
import {
  mountShell,
  shellWindow,
  shownWorkspace,
  tiledIds,
  type ShellApp,
} from '@tests/support/app/shell-app';
import type { ShellStore } from '@/app/state/shell-store';
import '@/app/styles.css';

const apps: ShellApp[] = [];

afterEach(() => {
  apps.splice(0).forEach(({ monitor }) => monitor.disconnect());
});

async function open(): Promise<ShellApp> {
  const app = await mountShell(
    [createWorkspace('One', split('row', 0.5, leaf('a'), leaf('b'))), createWorkspace('Two')],
    [shellWindow('a', 'readouts'), shellWindow('b', 'log')]
  );
  apps.push(app);
  return app;
}

function floating(store: ShellStore): string[] {
  return shownWorkspace(store).floating.map((entry) => entry.id);
}

function maximized(store: ShellStore): string | null {
  return shownWorkspace(store).maximized;
}

describe('the window menu, clicked with the pointer', () => {
  test('maximizes the window it belongs to and restores it', async () => {
    const { store, screen } = await open();
    await screen.getByRole('button', { name: 'Log menu' }).click();
    await screen.getByRole('menuitem', { name: /Maximize/ }).click();
    await expect.poll(() => maximized(store)).toBe('b');
    await screen.getByRole('button', { name: 'Log menu' }).click();
    await screen.getByRole('menuitem', { name: /Restore/ }).click();
    await expect.poll(() => maximized(store)).toBeNull();
  });

  test('floats the window and tiles it again', async () => {
    const { store, screen } = await open();
    await screen.getByRole('button', { name: 'Readouts menu' }).click();
    await screen.getByRole('menuitem', { name: /Float/ }).click();
    await expect.poll(() => floating(store)).toEqual(['a']);
    await settled();
    await screen.getByRole('button', { name: 'Readouts menu' }).click();
    await screen.getByRole('menuitem', { name: /Tile/ }).click();
    await expect.poll(() => floating(store)).toEqual([]);
  });

  test('moves the window to another workspace', async () => {
    const { store, screen } = await open();
    await screen.getByRole('button', { name: 'Log menu' }).click();
    await screen.getByRole('menuitem', { name: 'Move to workspace' }).click();
    await screen.getByRole('menuitem', { name: 'Two' }).click();
    await expect.poll(() => tiledIds(store, 1)).toEqual(['b']);
    expect(tiledIds(store, 0)).toEqual(['a']);
  });

  test('closes the window', async () => {
    const { store, screen } = await open();
    await screen.getByRole('button', { name: 'Log menu' }).click();
    await screen.getByRole('menuitem', { name: /Close/ }).click();
    await expect.poll(() => tiledIds(store)).toEqual(['a']);
  });
});

describe('the window keys', () => {
  test('maximize, float and close the focused window', async () => {
    const { store } = await open();
    await userEvent.keyboard('{Alt>}f{/Alt}');
    await expect.poll(() => maximized(store)).toBe('a');
    await userEvent.keyboard('{Alt>}f{/Alt}');
    await expect.poll(() => maximized(store)).toBeNull();
    await userEvent.keyboard('{Alt>}o{/Alt}');
    await expect.poll(() => floating(store)).toEqual(['a']);
    await userEvent.keyboard('{Alt>}q{/Alt}');
    await expect.poll(() => [...store.getState().desktop.windows.keys()]).toEqual(['b']);
  });
});
