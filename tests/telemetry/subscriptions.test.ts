import { describe, expect, test, vi } from 'vitest';

import { TelemetryStore } from '@/telemetry/store';
import { ManualScheduler } from '@/telemetry';

function twoVariables() {
  const scheduler = new ManualScheduler();
  const store = new TelemetryStore({ scheduler, blockSize: 256 });
  store.openEpoch({
    epochId: 1,
    groupId: 0,
    variables: [
      { id: 1, type: 'f32' },
      { id: 2, type: 'f32' },
    ],
  });
  store.openEpoch({ epochId: 2, groupId: 1, variables: [{ id: 3, type: 'f32' }] });
  scheduler.flush();
  return { scheduler, store };
}

describe('subscriptions', () => {
  test('hear about any number of samples once per tick', () => {
    const { scheduler, store } = twoVariables();
    const callback = vi.fn<() => void>();
    store.subscribe([1, 2], callback);

    for (let index = 0; index < 100; index++) {
      store.append(1, index, [index, -index]);
    }

    expect(callback).not.toHaveBeenCalled();
    expect(scheduler.pending).toBe(1);

    scheduler.flush();

    expect(callback).toHaveBeenCalledTimes(1);

    scheduler.flush();

    expect(callback).toHaveBeenCalledTimes(1);
  });

  test('only hear about the variables they asked for', () => {
    const { scheduler, store } = twoVariables();
    const first = vi.fn<() => void>();
    const third = vi.fn<() => void>();
    store.subscribe([1], first);
    store.subscribe([3], third);
    store.append(2, 0, [5]);
    scheduler.flush();

    expect(first).not.toHaveBeenCalled();
    expect(third).toHaveBeenCalledTimes(1);
  });

  test('stop when unsubscribed, and each subscription is called on its own', () => {
    const { scheduler, store } = twoVariables();
    const callback = vi.fn<() => void>();
    const unsubscribe = store.subscribe([1], callback);
    store.subscribe([1, 2], callback);
    store.append(1, 0, [1, 2]);
    scheduler.flush();

    expect(callback).toHaveBeenCalledTimes(2);

    unsubscribe();
    store.append(1, 1, [1, 2]);
    scheduler.flush();

    expect(callback).toHaveBeenCalledTimes(3);
  });

  test('see a version that changes with every change, and a stable latest value', () => {
    const { scheduler, store } = twoVariables();
    const before = store.version(1);
    store.append(1, 10, [1, 2]);
    const latest = store.latest(1);
    store.append(1, 20, [3, 4]);

    expect(store.version(1)).toBe(before + 2);
    expect(store.version(99)).toBe(0);
    expect(latest).toEqual({ value: 1, timeUs: 10 });
    expect(store.latest(1)).toEqual({ value: 3, timeUs: 20 });
    expect(store.latest(1)).toBe(store.latest(1));

    scheduler.flush();

    expect(store.version(1)).toBe(before + 2);
  });

  test('schedule changes made while notifying for the next tick', () => {
    const { scheduler, store } = twoVariables();
    let sequence = 0;
    const callback = vi.fn<() => void>(() => {
      if (sequence < 3) {
        store.append(1, sequence, [sequence++, 0]);
      }
    });
    store.subscribe([1], callback);
    store.append(1, sequence, [sequence++, 0]);
    scheduler.flush();

    expect(callback).toHaveBeenCalledTimes(1);
    expect(scheduler.pending).toBe(1);

    scheduler.flush();
    scheduler.flush();
    scheduler.flush();

    expect(callback).toHaveBeenCalledTimes(3);
    expect(scheduler.pending).toBe(0);
  });

  test('do not call a subscription ended earlier in the same tick', () => {
    const { scheduler, store } = twoVariables();
    const late = vi.fn<() => void>();
    const ends: (() => void)[] = [];
    store.subscribe([1], () => ends.forEach((end) => end()));
    ends.push(store.subscribe([1], late));
    store.append(1, 0, [1, 2]);
    scheduler.flush();

    expect(late).not.toHaveBeenCalled();
  });

  test('follow a name across a schema change', () => {
    const scheduler = new ManualScheduler();
    const store = new TelemetryStore({ scheduler, blockSize: 256 });
    const callback = vi.fn<() => void>();
    store.setSchema([{ id: 3, name: 'battery', type: 'f32' }]);
    store.subscribe(['battery'], callback);
    store.setSchema([{ id: 8, name: 'battery', type: 'f32' }]);
    store.openEpoch({ epochId: 1, groupId: 0, variables: [{ id: 8, type: 'f32' }] });
    scheduler.flush();
    callback.mockClear();
    store.append(1, 0, [7.4]);
    scheduler.flush();

    expect(callback).toHaveBeenCalledTimes(1);
    expect(store.version('battery')).toBe(store.version(8));
  });

  test('hear about boundaries and epochs through the status', () => {
    const { scheduler, store } = twoVariables();
    const callback = vi.fn<() => void>();
    const status = store.status();
    store.subscribeStatus(callback);
    store.markBoundary('reboot', 5);
    store.openEpoch({ epochId: 3, groupId: 0, variables: [{ id: 1, type: 'f32' }] });
    scheduler.flush();

    expect(callback).toHaveBeenCalledTimes(1);
    expect(store.status()).toBe(status);
  });
});
