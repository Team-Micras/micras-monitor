import { describe, expect, test } from 'vitest';

import { HistoryStore, ManualScheduler } from '@/history';

import { TransitionTracker } from '@/ui/windows/robot/transitions';

describe('TransitionTracker', () => {
  test('finds each change once, across scans and epochs', () => {
    const store = new HistoryStore({ scheduler: new ManualScheduler() });
    store.setSchema([{ id: 0, name: 'state', type: 'u8' }]);
    store.openEpoch({
      epochId: 1,
      groupId: 0,
      variables: [{ id: 0, type: 'u8' }],
    });
    [0, 0, 1, 1].forEach((value, index) => store.append(1, index * 1000, [value]));
    const tracker = new TransitionTracker(store, 'state');
    const first = tracker.update();

    expect(first).toEqual([
      { value: 0, timeUs: 0 },
      { value: 1, timeUs: 2000 },
    ]);
    expect(tracker.update()).toBe(first);

    store.closeEpoch(1);
    store.openEpoch({
      epochId: 2,
      groupId: 0,
      variables: [{ id: 0, type: 'u8' }],
    });
    [1, 3].forEach((value, index) => store.append(2, 10_000 + index * 1000, [value]));
    expect(tracker.update().at(-1)).toEqual({ value: 3, timeUs: 11_000 });
    expect(tracker.update()).toHaveLength(3);
  });

  test('starts over when the store is reset and the timeline restarts', () => {
    const store = new HistoryStore({ scheduler: new ManualScheduler() });
    store.setSchema([{ id: 0, name: 'state', type: 'u8' }]);
    store.openEpoch({
      epochId: 1,
      groupId: 0,
      variables: [{ id: 0, type: 'u8' }],
    });
    [1, 2].forEach((value, index) => store.append(1, 50_000 + index * 1000, [value]));
    const tracker = new TransitionTracker(store, 'state');
    expect(tracker.update()).toHaveLength(2);

    store.reset();
    expect(tracker.update()).toEqual([]);
    store.setSchema([{ id: 0, name: 'state', type: 'u8' }]);
    store.openEpoch({
      epochId: 2,
      groupId: 0,
      variables: [{ id: 0, type: 'u8' }],
    });
    [2, 2, 3].forEach((value, index) => store.append(2, index * 1000, [value]));
    expect(tracker.update()).toEqual([
      { value: 2, timeUs: 0 },
      { value: 3, timeUs: 2000 },
    ]);
  });

  test('starts over when the store is reset and appended to before the next scan', () => {
    const store = new HistoryStore({ scheduler: new ManualScheduler() });
    store.setSchema([{ id: 0, name: 'state', type: 'u8' }]);
    store.openEpoch({
      epochId: 1,
      groupId: 0,
      variables: [{ id: 0, type: 'u8' }],
    });
    [1, 2].forEach((value, index) => store.append(1, index * 1000, [value]));
    const tracker = new TransitionTracker(store, 'state');
    expect(tracker.update()).toHaveLength(2);

    store.reset();
    [3, 4].forEach((value, index) => store.append(1, 5000 + index * 1000, [value]));

    expect(tracker.update()).toEqual([
      { value: 3, timeUs: 5000 },
      { value: 4, timeUs: 6000 },
    ]);
  });
});
