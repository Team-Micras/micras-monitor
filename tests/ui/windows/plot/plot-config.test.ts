import { afterEach, describe, expect, test, vi } from 'vitest';

import { drawGaps, type GapCanvas, type PlotTheme } from '@/ui/windows/plot/plot-config';
import type { GapSpan } from '@/ui/windows/plot/plot-data';

const THEME: PlotTheme = {
  axis: 'axis',
  grid: 'grid',
  dropped: 'red',
  notStored: 'gray',
  font: '10px mono',
};

interface Fill {
  readonly style: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

function fakePlot(): { plot: GapCanvas; fills: Fill[] } {
  const fills: Fill[] = [];
  const ctx = {
    fillStyle: '',
    globalAlpha: 1,
    save: () => undefined,
    restore: () => undefined,
    fillRect(x: number, y: number, width: number, height: number) {
      fills.push({ style: ctx.fillStyle, x, y, width, height });
    },
  };
  const plot: GapCanvas = {
    ctx,
    bbox: { top: 4, height: 200 },
    valToPos: (seconds) => seconds * 100,
  };
  return { plot, fills };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('drawGaps', () => {
  test('fills dropped spans in the dropped color and the others in the not-kept color', () => {
    vi.stubGlobal('devicePixelRatio', 1);
    const { plot, fills } = fakePlot();
    const spans: GapSpan[] = [
      { kind: 'dropped', startUs: 1_000_000, endUs: 2_000_000 },
      { kind: 'not-stored', startUs: 3_000_000, endUs: 5_000_000 },
    ];
    drawGaps(plot, spans, THEME);
    expect(fills).toEqual([
      { style: 'red', x: 100, y: 4, width: 100, height: 200 },
      { style: 'gray', x: 300, y: 4, width: 200, height: 200 },
    ]);
  });

  test('draws a span at least one device pixel wide', () => {
    vi.stubGlobal('devicePixelRatio', 2);
    const { plot, fills } = fakePlot();
    drawGaps(plot, [{ kind: 'dropped', startUs: 1_000_000, endUs: 1_000_001 }], THEME);
    expect(fills).toHaveLength(1);
    expect(fills[0].style).toBe('red');
    expect(fills[0].width).toBe(2);
  });

  test('draws nothing without spans', () => {
    const { plot, fills } = fakePlot();
    drawGaps(plot, [], THEME);
    expect(fills).toEqual([]);
  });
});
