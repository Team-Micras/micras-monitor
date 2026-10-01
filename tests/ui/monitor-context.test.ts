import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { PackageChooser, subscribeThrottled } from '@/ui/monitor-context';
import type { Variable } from '@/core/variables';
import { RobotRegistry } from '@/core/robot';
import { ManualScheduler, HistoryStore } from '@/history';
import { mouse } from '@tests/support/core/robot/packages';

const ACCESS = { stream: true, write: false, writeNeedsIdle: false, persists: false };
const VARIABLES: readonly Variable[] = [
  { id: 0, name: 'battery_voltage', type: 'f32', access: ACCESS },
];

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('subscribeThrottled', () => {
  test('calls at most once per interval and delivers the last change at its end', () => {
    const scheduler = new ManualScheduler();
    const history = new HistoryStore({ scheduler });
    history.setSchema(VARIABLES);
    const listener = vi.fn<() => void>();
    const stop = subscribeThrottled(history, 'battery_voltage', listener, 100);
    history.setLatestValue(0, 12);
    scheduler.flush();
    expect(listener).toHaveBeenCalledTimes(1);

    history.setLatestValue(0, 11);
    scheduler.flush();
    expect(listener).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(100);
    expect(listener).toHaveBeenCalledTimes(2);
    stop();
  });
});

describe('PackageChooser', () => {
  const chooser = new PackageChooser(new RobotRegistry<ReactNode>([mouse({ id: 'micras' })]));

  test('chooses once per robot name and list of variables', () => {
    const first = chooser.choose('micras', VARIABLES);

    expect(first?.package.id).toBe('micras');
    expect(chooser.choose('micras', VARIABLES)).toBe(first);
    expect(chooser.choose('other', VARIABLES)).toBeNull();
    expect(chooser.choose('micras', [...VARIABLES])).not.toBe(first);
  });

  test('chooses nothing while the variables are not known', () => {
    expect(chooser.choose('micras', [])).toBeNull();
  });
});
