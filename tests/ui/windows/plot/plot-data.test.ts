import { describe, expect, test } from 'vitest';

import { HistoryStore, ManualScheduler } from '@/history';

import {
  followWindow,
  latestEnd,
  layoutAxes,
  MAX_PLOT_COLUMNS,
  PlotData,
  visibleGaps,
  type PlotVariable,
} from '@/ui/windows/plot/plot-data';

const SPEED = 'pose/linear_speed';
const REFERENCE = 'reference/linear_speed';

function store(): HistoryStore {
  const telemetry = new HistoryStore({ scheduler: new ManualScheduler() });
  telemetry.setSchema([
    { id: 0, name: SPEED, type: 'f32' },
    { id: 1, name: REFERENCE, type: 'f32' },
  ]);
  telemetry.openRun({
    runId: 1,
    slot: 0,
    variables: [
      { id: 0, type: 'f32' },
      { id: 1, type: 'f32' },
    ],
  });
  return telemetry;
}

function fill(telemetry: HistoryStore, samples: number, stepUs: number, skip = new Set<number>()) {
  let missed = 0;

  for (let index = 0; index < samples; index++) {
    if (skip.has(index)) {
      missed++;
    } else {
      telemetry.append(1, index * stepUs, [index % 10 === 5 ? Number.NaN : index, 1], missed);
      missed = 0;
    }
  }
}

const variable = (name: string, unit: string | null): PlotVariable => ({
  name,
  unit,
  color: 'red',
});

describe('layoutAxes', () => {
  test('gives each unit an axis, the first on the left, and shares it within the unit', () => {
    const layout = layoutAxes([
      variable('a', 'm/s'),
      variable('b', 'rad'),
      variable('c', 'm/s'),
      variable('d', null),
    ]);
    expect(layout.axes).toEqual([
      { scale: 'y0', unit: 'm/s', side: 'left' },
      { scale: 'y1', unit: 'rad', side: 'right' },
      { scale: 'y2', unit: null, side: 'right' },
    ]);
    expect(layout.scales).toEqual(['y0', 'y1', 'y0', 'y2']);
  });
});

describe('PlotData', () => {
  test('lays out three slots per column in seconds, with nulls where the line breaks', () => {
    const telemetry = store();
    fill(telemetry, 100, 1000);
    const [x, speed, reference] = new PlotData(telemetry).build(
      [SPEED, REFERENCE],
      { startUs: 0, endUs: 100_000 },
      100
    );

    expect(x).toHaveLength(300);
    expect(x[1]).toBeCloseTo(0.0005);
    expect(speed[3 * 3 + 1]).toBe(3);
    expect(speed.slice(15, 18)).toEqual([null, null, null]);
    expect(reference.every((value) => value === 1 || value === undefined)).toBe(true);
  });

  test('breaks the line at dropped samples and marks them', () => {
    const telemetry = store();
    fill(telemetry, 100, 1000, new Set([40, 41, 42]));
    const window = { startUs: 0, endUs: 100_000 };
    const gaps = visibleGaps(telemetry, [SPEED], window);
    expect(gaps.dropped).toBe(3);
    expect(gaps.spans).toEqual([{ kind: 'dropped', startUs: 39_000, endUs: 43_000 }]);
    const [, line] = new PlotData(telemetry).build([REFERENCE], window, 100);
    expect(line.slice(39 * 3, 40 * 3)).toEqual([1, 1, null]);
  });

  test('reuses its arrays frame after frame and clamps the columns', () => {
    const telemetry = store();
    fill(telemetry, 50, 1000);
    const data = new PlotData(telemetry);
    const first = data.build([SPEED], { startUs: 0, endUs: 50_000 }, 50);
    fill(telemetry, 60, 1000);
    const second = data.build([SPEED], { startUs: 0, endUs: 50_000 }, 50);

    expect(second[0]).toBe(first[0]);
    expect(second[1]).toBe(first[1]);
    expect(data.build([SPEED], { startUs: 0, endUs: 50_000 }, 1e6)[0]).toHaveLength(
      3 * MAX_PLOT_COLUMNS
    );
  });
});

describe('the live window', () => {
  test('ends at the newest sample of any variable and moves in whole columns', () => {
    const telemetry = store();
    expect(followWindow(telemetry, [SPEED], 10_000, 10)).toBeUndefined();
    fill(telemetry, 20, 1000);
    const end = latestEnd(telemetry, [SPEED, REFERENCE]) ?? 0;
    const window = followWindow(telemetry, [SPEED], 10_000, 10);

    expect(end).toBeGreaterThan(19_000);
    expect(window?.endUs).toBe(20_000);
    expect(window?.startUs).toBe(10_000);
  });
});
