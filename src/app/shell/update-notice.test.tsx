import { describe, expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';

import type { AppUpdates } from '../pwa/app-updates';
import { PRELOAD_ERROR_EVENT, UpdateNotice } from './update-notice';

describe('UpdateNotice', () => {
  test('says that part of the app could not load once a preload fails, with a reload button', async () => {
    const screen = await render(<UpdateNotice />);
    await expect.element(screen.getByRole('status')).not.toBeInTheDocument();

    window.dispatchEvent(new Event(PRELOAD_ERROR_EVENT));
    await expect
      .element(screen.getByRole('status'))
      .toHaveTextContent("Couldn't load part of the app");
    await expect.element(screen.getByRole('button', { name: 'Reload' })).toBeVisible();
  });

  test('offers a waiting update and applies it only when the button is pressed', async () => {
    const listeners = new Set<() => void>();
    let waiting = false;
    const apply = vi.fn<() => void>();
    const updates: AppUpdates = {
      waiting: () => waiting,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      apply,
    };
    const screen = await render(<UpdateNotice updates={updates} />);
    await expect.element(screen.getByRole('status')).not.toBeInTheDocument();

    waiting = true;
    listeners.forEach((listener) => listener());
    await expect.element(screen.getByRole('status')).toHaveTextContent('Update available');
    expect(apply).not.toHaveBeenCalled();

    await screen.getByRole('button', { name: 'Reload' }).click();
    expect(apply).toHaveBeenCalledTimes(1);
  });

  test('refuses to reload while the reload is blocked, and says why', async () => {
    const apply = vi.fn<() => void>();
    const updates: AppUpdates = { waiting: () => true, subscribe: () => () => undefined, apply };
    const screen = await render(<UpdateNotice updates={updates} reloadBlocked />);

    await expect
      .element(screen.getByRole('status'))
      .toHaveTextContent('Reload once the robot is idle');
    await expect.element(screen.getByRole('button', { name: 'Reload' })).toBeDisabled();
    expect(apply).not.toHaveBeenCalled();
  });
});
