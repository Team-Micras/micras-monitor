import { describe, expect, test } from 'vitest';

import { TypeCode } from '@/protocol';
import { TelemetryStore } from '@/telemetry';

import {
  clampWindow,
  historyBounds,
  MIN_SPAN_US,
  panWindow,
  wholeHistory,
  zoomWindow,
} from '@/app/windows/plot/plot-navigation';
import { ManualScheduler } from '@tests/support/telemetry/manual-scheduler';

const BOUNDS = { startUs: 0, endUs: 60_000_000 };

describe('moving a paused plot through the history', () => {
  test('zooms around the time under the pointer', () => {
    const window = { startUs: 10_000_000, endUs: 20_000_000 };
    const zoomed = zoomWindow(window, 12_000_000, 0.5, BOUNDS);

    expect(zoomed).toEqual({ startUs: 11_000_000, endUs: 16_000_000 });
    expect(zoomWindow(zoomed, 12_000_000, 2, BOUNDS)).toEqual(window);
  });

  test('keeps the window between a millisecond and twice the history', () => {
    const window = { startUs: 10_000_000, endUs: 10_002_000 };

    expect(zoomWindow(window, 10_001_000, 0.01, BOUNDS).endUs - 10_000_500).toBe(MIN_SPAN_US);
    expect(zoomWindow(window, 10_001_000, 1e9, BOUNDS)).toEqual({
      startUs: -30_000_000,
      endUs: 90_000_000,
    });
  });

  test('pans, stopping half a window past either end', () => {
    const window = { startUs: 10_000_000, endUs: 20_000_000 };

    expect(panWindow(window, 5_000_000, BOUNDS)).toEqual({
      startUs: 15_000_000,
      endUs: 25_000_000,
    });
    expect(panWindow(window, -1e9, BOUNDS)).toEqual({ startUs: -5_000_000, endUs: 5_000_000 });
    expect(panWindow(window, 1e9, BOUNDS)).toEqual({ startUs: 55_000_000, endUs: 65_000_000 });
  });

  test('shows the whole history, and keeps a window wider than it centred on it', () => {
    expect(wholeHistory(BOUNDS)).toEqual(BOUNDS);
    expect(clampWindow({ startUs: 100e6, endUs: 190e6 }, BOUNDS)).toEqual({
      startUs: -15_000_000,
      endUs: 75_000_000,
    });
  });

  test('bounds the history by the variables that have samples', () => {
    const store = new TelemetryStore({ scheduler: new ManualScheduler() });
    store.setSchema([
      { id: 0, name: 'a', type: TypeCode.F32 },
      { id: 1, name: 'b', type: TypeCode.F32 },
    ]);
    store.openEpoch({ epochId: 1, groupId: 0, variables: [{ id: 0, type: TypeCode.F32 }] });
    store.append(1, 0, 1000, [1]);
    store.append(1, 1, 5000, [2]);

    expect(historyBounds(store, ['a', 'b'])).toEqual({
      startUs: 1000,
      endUs: store.timeRange('a')!.endUs,
    });
    expect(historyBounds(store, ['b'])).toBeUndefined();
  });
});
