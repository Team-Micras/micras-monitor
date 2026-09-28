import { describe, expect, test } from 'vitest';

import { METRICS, desktopOf, tileOf } from './fixtures/desktops';
import { outsideOf, tooCloseOf } from './fixtures/invariants';
import {
  createWorkspace,
  layoutTree,
  layoutWorkspace,
  leaf,
  minimumSize,
  ratioAtPoint,
  resetSplit,
  resizeSplit,
  split,
  usableBounds,
  type LayoutMetrics,
} from './index';

function widthsOf(root: Parameters<typeof layoutTree>[0], metrics: LayoutMetrics) {
  const { tiles } = layoutTree(root, metrics);
  return Object.fromEntries([...tiles].map(([id, rect]) => [id, rect.width]));
}

describe('nested minimum sizes', () => {
  const nested = split(
    'row',
    0.5,
    leaf('a'),
    split('column', 0.5, leaf('b'), split('row', 0.5, leaf('c'), leaf('d')))
  );

  test('a split needs the sum along its axis and the larger child across it', () => {
    expect(minimumSize(nested, METRICS)).toEqual({ width: 3 * 240 + 2 * 14, height: 2 * 150 + 14 });
    expect(
      minimumSize(split('column', 0.5, split('row', 0.5, leaf('a'), leaf('b')), leaf('c')), METRICS)
    ).toEqual({
      width: 2 * 240 + 14,
      height: 2 * 150 + 14,
    });
    expect(minimumSize(null, METRICS)).toEqual({ width: 0, height: 0 });
  });

  test('dragging an outer gap stops where a nested window reaches its minimum', () => {
    const d = resizeSplit(desktopOf([createWorkspace('W', nested)]), '', 0.99, METRICS);
    expect(tileOf(d, 'c').width).toBe(240);
    expect(tileOf(d, 'd').width).toBe(240);
    const { gutters } = layoutTree(d.workspaces[0].root, METRICS);
    const available = usableBounds(METRICS).width - 14;
    expect(gutters[0].maxRatio).toBeCloseTo((available - (2 * 240 + 14)) / available);
  });

  test('when the minimums cannot fit, windows along the axis shrink by the same factor and gaps stay exact', () => {
    const metrics = { ...METRICS, width: 600 };
    const widths = widthsOf(nested, metrics);
    expect(Math.abs(widths.a - widths.c)).toBeLessThanOrEqual(1);
    expect(Math.abs(widths.c - widths.d)).toBeLessThanOrEqual(1);
    expect(widths.b).toBe(widths.c + 14 + widths.d);
    const rects = [...layoutTree(nested, metrics).tiles.values()];
    expect(tooCloseOf(rects, 14)).toEqual([]);
    expect(outsideOf(rects, usableBounds(metrics))).toEqual([]);
  });

  test('a row of windows too wide for the viewport shares it evenly', () => {
    const row = split(
      'row',
      0.9,
      leaf('a'),
      split('row', 0.1, leaf('b'), split('row', 0.5, leaf('c'), leaf('d')))
    );
    const widths = Object.values(widthsOf(row, { ...METRICS, width: 700 }));
    expect(Math.max(...widths) - Math.min(...widths)).toBeLessThanOrEqual(1);
    expect(widths.reduce((sum, width) => sum + width, 0)).toBe(700 - 28 - 3 * 14);
  });

  test('a split with no room to move cannot be resized and keeps its ratio', () => {
    const d = desktopOf([createWorkspace('W', split('row', 0.3, leaf('a'), leaf('b')))]);
    const tight = { ...METRICS, width: 400 };
    expect(resizeSplit(d, '', 0.8, tight)).toBe(d);
    expect(resetSplit(d, '', tight)).toBe(d);
  });

  test('a viewport smaller than the gaps keeps rects inside it and apart', () => {
    const metrics = { ...METRICS, width: 40, height: 30 };
    const rects = [...layoutTree(nested, metrics).tiles.values()];
    expect(outsideOf(rects, { x: 0, y: 0, width: 40, height: 30 })).toEqual([]);
    expect(tooCloseOf(rects, 0)).toEqual([]);
  });
});

describe('geometry', () => {
  test('the outer gap and the gap between windows are separate', () => {
    const metrics = { ...METRICS, gap: 8, outerGap: 20 };
    const { tiles, gutters } = layoutTree(split('row', 0.5, leaf('a'), leaf('b')), metrics);
    const a = tiles.get('a');
    const b = tiles.get('b');
    expect(a).toMatchObject({ x: 20, y: 20, height: metrics.height - 40 });
    expect(b && a && b.x - (a.x + a.width)).toBe(8);
    expect(b && b.x + b.width).toBe(metrics.width - 20);
    expect(gutters[0].rect).toEqual({
      x: a && a.x + a.width,
      y: 20,
      width: 8,
      height: metrics.height - 40,
    });
  });

  test('a pointer on a gutter maps to its ratio and is clamped to the minimums', () => {
    const { gutters } = layoutTree(split('column', 0.3, leaf('a'), leaf('b')), METRICS);
    const [gutter] = gutters;
    const centre = gutter.rect.y + gutter.rect.height / 2;
    expect(ratioAtPoint(gutter, { x: 100, y: centre })).toBeCloseTo(gutter.ratio, 2);
    expect(ratioAtPoint(gutter, { x: 100, y: 0 })).toBe(gutter.minRatio);
    expect(ratioAtPoint(gutter, { x: 100, y: METRICS.height })).toBe(gutter.maxRatio);
  });

  test('gutters name the first window on each side', () => {
    const { gutters } = layoutTree(
      split('row', 0.5, split('column', 0.5, leaf('a'), leaf('b')), leaf('c')),
      METRICS
    );
    expect(gutters.map((g) => [g.path, g.between])).toEqual([
      ['', ['a', 'c']],
      ['0', ['a', 'b']],
    ]);
  });

  test('floating windows are fitted to a viewport that shrank', () => {
    const workspace = {
      ...createWorkspace('W', leaf('a')),
      floating: [{ id: 'f', rect: { x: 1400, y: 700, width: 600, height: 400 }, dock: null }],
    };
    const small = { ...METRICS, width: 800, height: 500 };
    const f = layoutWorkspace(workspace, small).windows.find((w) => w.id === 'f');
    expect(f?.rect).toEqual({ x: 186, y: 86, width: 600, height: 400 });
    expect(workspace.floating[0].rect.x).toBe(1400);
  });
});
