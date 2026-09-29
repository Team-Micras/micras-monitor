import { afterEach, describe, expect, test, vi } from 'vitest';
import { userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-react';

import '../styles.css';
import { createShellStore, ShellStoreContext, type ShellStore } from '../state/shell-store';
import { DeletedNotice } from './deleted-notice';

const DURATION_MS = 1500;

async function show(
  durationMs = DURATION_MS
): Promise<{ store: ShellStore; screen: Awaited<ReturnType<typeof render>> }> {
  const store = createShellStore();
  store.getState().savePreset('Bench');
  const screen = await render(
    <ShellStoreContext value={store}>
      <DeletedNotice durationMs={durationMs} />
      <input aria-label="Field" />
    </ShellStoreContext>
  );
  store.getState().deletePreset('Bench');
  return { store, screen };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('the notice of a deleted layout', () => {
  test('goes away after its time', async () => {
    const { store, screen } = await show(200);
    await expect.element(screen.getByRole('status')).toBeVisible();
    await expect.poll(() => store.getState().deletedPreset).toBeNull();
    await expect.element(screen.getByRole('status')).not.toBeInTheDocument();
  });

  test('stays while the pointer is on it, and counts again once it leaves', async () => {
    vi.useFakeTimers();
    const { store, screen } = await show();
    await userEvent.hover(screen.getByRole('button', { name: 'Undo' }));
    await vi.advanceTimersByTimeAsync(DURATION_MS + 500);
    expect(store.getState().deletedPreset).not.toBeNull();

    await userEvent.unhover(screen.getByRole('button', { name: 'Undo' }));
    await vi.advanceTimersByTimeAsync(DURATION_MS + 500);
    expect(store.getState().deletedPreset).toBeNull();
  });

  test('stays while it has the focus', async () => {
    vi.useFakeTimers();
    const { store, screen } = await show();
    await userEvent.tab();
    await expect.element(screen.getByRole('button', { name: 'Undo' })).toHaveFocus();
    await vi.advanceTimersByTimeAsync(DURATION_MS + 500);
    expect(store.getState().deletedPreset).not.toBeNull();
  });

  test('is undone by Ctrl+Z, but not while typing in a field', async () => {
    vi.useFakeTimers();
    const { store, screen } = await show();
    await screen.getByRole('textbox', { name: 'Field' }).click();
    await userEvent.keyboard('{Control>}z{/Control}');
    expect(store.getState().presets).toEqual([]);

    await userEvent.click(document.body);
    await userEvent.keyboard('{Control>}z{/Control}');
    expect(store.getState().presets.map((preset) => preset.name)).toEqual(['Bench']);
  });
});
