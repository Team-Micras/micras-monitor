import { describe, expect, test, vi } from 'vitest';

import { serviceWorkerUpdates, type RegisterServiceWorker } from './app-updates';

function fakeRegistration() {
  const announced: (() => void)[] = [];
  const activate = vi.fn<(reload: boolean) => Promise<void>>(() => Promise.resolve());
  const register: RegisterServiceWorker = ({ onNeedRefresh }) => {
    announced.push(onNeedRefresh);
    return activate;
  };
  return { register, activate, announce: () => announced.forEach((call) => call()) };
}

describe('serviceWorkerUpdates', () => {
  test('waits quietly until the worker announces a build, then tells its listeners', () => {
    const { register, announce } = fakeRegistration();
    const updates = serviceWorkerUpdates(register);
    const listener = vi.fn<() => void>();
    updates.subscribe(listener);
    expect(updates.waiting()).toBe(false);

    announce();

    expect(updates.waiting()).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  test('activates the waiting build with a reload only when asked to apply it', () => {
    const { register, activate, announce } = fakeRegistration();
    const updates = serviceWorkerUpdates(register);
    announce();
    expect(activate).not.toHaveBeenCalled();

    updates.apply();

    expect(activate).toHaveBeenCalledWith(true);
  });

  test('stops telling a listener that unsubscribed', () => {
    const { register, announce } = fakeRegistration();
    const updates = serviceWorkerUpdates(register);
    const listener = vi.fn<() => void>();
    updates.subscribe(listener)();

    announce();

    expect(listener).not.toHaveBeenCalled();
  });
});
