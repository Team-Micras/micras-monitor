import { describe, expect, test } from 'vitest';

import { METRICS, desktopOf, overview, tileOf } from './fixtures/desktops';
import {
  cornerCrossing,
  cornerHandles,
  cornerSplits,
  createWorkspace,
  leaf,
  nodeAt,
  resizeCorner,
  split,
  toggleMaximize,
  type Desktop,
  type NodePath,
} from './index';

function ratioOf(desktop: Desktop, path: NodePath): number {
  const node = nodeAt(desktop.workspaces[desktop.active].root, path);
  return node?.type === 'split' ? node.ratio : Number.NaN;
}

describe('the splits at a corner', () => {
  test('are the side-by-side and the stacked split whose gaps meet there', () => {
    const { root } = overview().workspaces[0];
    expect(cornerSplits(root, 'track', 'bottom-right')).toEqual({ row: '', column: '0' });
    expect(cornerSplits(root, 'robot', 'top-right')).toEqual({ row: '', column: '0' });
    expect(cornerSplits(root, 'maze', 'bottom-left')).toEqual({ row: '', column: '1' });
    expect(cornerSplits(root, 'profile', 'top-left')).toEqual({ row: '', column: '1' });
  });

  test('are none on the edges of the tiling or for a window that is not tiled', () => {
    const { root } = overview().workspaces[0];
    expect(cornerSplits(root, 'track', 'top-left')).toBeNull();
    expect(cornerSplits(root, 'track', 'top-right')).toBeNull();
    expect(cornerSplits(root, 'track', 'bottom-left')).toBeNull();
    expect(cornerSplits(root, 'nowhere', 'bottom-right')).toBeNull();
    expect(cornerSplits(split('row', 0.5, leaf('a'), leaf('b')), 'a', 'bottom-right')).toBeNull();
  });

  test('are the nearest splits of each kind in a nested tree', () => {
    const root = split(
      'row',
      0.5,
      leaf('a'),
      split('column', 0.5, leaf('b'), split('row', 0.5, leaf('c'), leaf('d')))
    );
    expect(cornerSplits(root, 'c', 'top-left')).toEqual({ row: '', column: '1' });
    expect(cornerSplits(root, 'd', 'top-left')).toEqual({ row: '11', column: '1' });
    expect(cornerSplits(root, 'b', 'bottom-left')).toEqual({ row: '', column: '1' });
  });
});

describe('corner handles', () => {
  test('sit where two gaps meet, each over its own quarter of the crossing', () => {
    const handles = cornerHandles(overview(), METRICS, 8);
    expect(handles.map(({ id, corner }) => `${id} ${corner}`)).toEqual([
      'track bottom-right',
      'robot top-right',
      'maze bottom-left',
      'profile top-left',
    ]);
    const track = tileOf(overview(), 'track');
    expect(handles[0].rect).toEqual({
      x: track.x + track.width - 8,
      y: track.y + track.height - 8,
      width: 8 + METRICS.gap / 2,
      height: 8 + METRICS.gap / 2,
    });
    const robot = handles[1].rect;
    expect(robot.y).toBe(handles[0].rect.y + handles[0].rect.height);
  });

  test('are none while a window is maximized', () => {
    expect(cornerHandles(toggleMaximize(overview()), METRICS, 8)).toEqual([]);
  });
});

describe('resizing from a corner', () => {
  test('moves both gaps so that they cross under the point', () => {
    const before = overview();
    const splits = { row: '', column: '0' };
    const point = { x: 700, y: 300 };
    const after = resizeCorner(before, splits, point, METRICS);
    expect(cornerCrossing(after, splits, METRICS)).toEqual(point);
    const track = tileOf(after, 'track');
    expect(track.x + track.width + METRICS.gap / 2).toBeCloseTo(700);
    expect(track.y + track.height + METRICS.gap / 2).toBeCloseTo(300);
    expect(ratioOf(after, '1')).toBe(ratioOf(before, '1'));
  });

  test('keeps every window at its minimum size', () => {
    const after = resizeCorner(overview(), { row: '', column: '1' }, { x: 1e6, y: -1e6 }, METRICS);
    expect(tileOf(after, 'maze').width).toBeGreaterThanOrEqual(METRICS.minWidth);
    expect(tileOf(after, 'maze').height).toBeGreaterThanOrEqual(METRICS.minHeight);
    expect(tileOf(after, 'profile').height).toBeGreaterThan(tileOf(overview(), 'profile').height);
  });

  test('leaves splits that are gone alone', () => {
    const d = desktopOf([createWorkspace('One', leaf('a'))]);
    expect(resizeCorner(d, { row: '', column: '0' }, { x: 10, y: 10 }, METRICS)).toBe(d);
    expect(cornerCrossing(d, { row: '', column: '0' }, METRICS)).toBeNull();
  });
});
