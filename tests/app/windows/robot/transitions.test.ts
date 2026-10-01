import { describe, expect, test } from 'vitest';

import { TypeCode } from '@/protocol';
import { TelemetryStore } from '@/telemetry';

import { TransitionTracker } from '@/app/windows/robot/transitions';
import { ManualScheduler } from '@tests/support/telemetry/manual-scheduler';

describe('TransitionTracker', () => {
  test('finds each change once, across scans and epochs', () => {
    const store = new TelemetryStore({ scheduler: new ManualScheduler() });
    store.setSchema([{ id: 0, name: 'state', type: TypeCode.U8 }]);
    store.openEpoch({
      epochId: 1,
      groupId: 0,
      variables: [{ id: 0, type: TypeCode.U8 }],
      firstSequence: 0,
    });
    [0, 0, 1, 1].forEach((value, index) => store.append(1, index, index * 1000, [value]));
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
      variables: [{ id: 0, type: TypeCode.U8 }],
      firstSequence: 0,
    });
    [1, 3].forEach((value, index) => store.append(2, index, 10_000 + index * 1000, [value]));
    expect(tracker.update().at(-1)).toEqual({ value: 3, timeUs: 11_000 });
    expect(tracker.update()).toHaveLength(3);
  });

  test('starts over when the store is reset and the timeline restarts', () => {
    const store = new TelemetryStore({ scheduler: new ManualScheduler() });
    store.setSchema([{ id: 0, name: 'state', type: TypeCode.U8 }]);
    store.openEpoch({
      epochId: 1,
      groupId: 0,
      variables: [{ id: 0, type: TypeCode.U8 }],
      firstSequence: 0,
    });
    [1, 2].forEach((value, index) => store.append(1, index, 50_000 + index * 1000, [value]));
    const tracker = new TransitionTracker(store, 'state');
    expect(tracker.update()).toHaveLength(2);

    store.reset();
    expect(tracker.update()).toEqual([]);
    store.setSchema([{ id: 0, name: 'state', type: TypeCode.U8 }]);
    store.openEpoch({
      epochId: 2,
      groupId: 0,
      variables: [{ id: 0, type: TypeCode.U8 }],
      firstSequence: 0,
    });
    [2, 2, 3].forEach((value, index) => store.append(2, index, index * 1000, [value]));
    expect(tracker.update()).toEqual([
      { value: 2, timeUs: 0 },
      { value: 3, timeUs: 2000 },
    ]);
  });

  test('starts over when the store is reset and appended to before the next scan', () => {
    const store = new TelemetryStore({ scheduler: new ManualScheduler() });
    store.setSchema([{ id: 0, name: 'state', type: TypeCode.U8 }]);
    store.openEpoch({
      epochId: 1,
      groupId: 0,
      variables: [{ id: 0, type: TypeCode.U8 }],
      firstSequence: 0,
    });
    [1, 2].forEach((value, index) => store.append(1, index, index * 1000, [value]));
    const tracker = new TransitionTracker(store, 'state');
    expect(tracker.update()).toHaveLength(2);

    store.reset();
    [3, 4].forEach((value, index) => store.append(1, 2 + index, 5000 + index * 1000, [value]));

    expect(tracker.update()).toEqual([
      { value: 3, timeUs: 5000 },
      { value: 4, timeUs: 6000 },
    ]);
  });
});
