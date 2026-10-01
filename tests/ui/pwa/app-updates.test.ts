import { describe, expect, test, vi } from 'vitest';

import { serviceWorkerUpdates, type RegisterServiceWorker } from '@/ui/pwa/app-updates';

function fakeRegistration() {
  const hooks: Parameters<RegisterServiceWorker>[0][] = [];
  const activate = vi.fn<(reload: boolean) => Promise<void>>(() => Promise.resolve());
  const register: RegisterServiceWorker = (given) => {
    hooks.push(given);
    return activate;
  };
  const reload = vi.fn<() => void>();
  return {
    register,
    activate,
    reload,
    refresh: () => hooks.forEach((given) => given.onNeedRefresh()),
    controlled: () => hooks.forEach((given) => given.onNeedReload()),
  };
}

describe('serviceWorkerUpdates', () => {
  test('waits quietly until the worker announces a build, then tells its listeners', () => {
    const { register, refresh } = fakeRegistration();
    const updates = serviceWorkerUpdates(register);
    const listener = vi.fn<() => void>();
    updates.subscribe(listener);
    expect(updates.waiting()).toBe(false);

    refresh();

    expect(updates.waiting()).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  test('activates the waiting build only when asked to apply it, and reloads once it controls', () => {
    const { register, activate, reload, refresh, controlled } = fakeRegistration();
    const updates = serviceWorkerUpdates(register, reload);
    refresh();
    expect(activate).not.toHaveBeenCalled();

    updates.apply();
    expect(activate).toHaveBeenCalledWith(true);
    expect(reload).not.toHaveBeenCalled();

    controlled();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  test('does not reload a tab when another tab made the new build take control', () => {
    const { register, reload, refresh, controlled } = fakeRegistration();
    const updates = serviceWorkerUpdates(register, reload);
    refresh();

    controlled();

    expect(reload).not.toHaveBeenCalled();
    expect(updates.waiting()).toBe(true);
  });

  test('reloads at once when applied after another tab already switched builds', () => {
    const { register, activate, reload, controlled } = fakeRegistration();
    const updates = serviceWorkerUpdates(register, reload);
    controlled();

    updates.apply();

    expect(reload).toHaveBeenCalledTimes(1);
    expect(activate).not.toHaveBeenCalled();
  });

  test('stops telling a listener that unsubscribed', () => {
    const { register, refresh } = fakeRegistration();
    const updates = serviceWorkerUpdates(register);
    const listener = vi.fn<() => void>();
    updates.subscribe(listener)();

    refresh();

    expect(listener).not.toHaveBeenCalled();
  });
});
