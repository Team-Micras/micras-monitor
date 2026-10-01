import { describe, expect, test } from 'vitest';

import { centerOf } from '@/tiling/geometry';
import { METRICS, desktopOf, overview, tileOf, windowOf } from '@tests/support/tiling/desktops';
import {
  applyDrop,
  closeWindow,
  createWorkspace,
  focusDirection,
  focusedWindow,
  hitTest,
  layoutTree,
  layoutWorkspace,
  leaf,
  leafIds,
  LayoutError,
  moveToWorkspace,
  openWindow,
  resetSplit,
  resizeSplit,
  restoreDesktop,
  serializeDesktop,
  split,
  swapDirection,
  toggleFloating,
  toggleMaximize,
  type Desktop,
  type DropTarget,
  type Side,
} from '@/tiling';

function edgeTarget(desktop: Desktop, dragged: string, id: string, side: Side): DropTarget {
  const tile = tileOf(desktop, id);
  const center = centerOf(tile);
  const points: Record<Side, { x: number; y: number }> = {
    left: { x: tile.x + 4, y: center.y },
    right: { x: tile.x + tile.width - 4, y: center.y },
    top: { x: center.x, y: tile.y + 4 },
    bottom: { x: center.x, y: tile.y + tile.height - 4 },
  };
  const target = hitTest(desktop, dragged, points[side], METRICS);

  if (target === null) {
    throw new Error(`nothing under the ${side} edge of "${id}"`);
  }

  return target;
}

describe('layout', () => {
  test('tiles leave the gap between windows and to the edges', () => {
    const d = overview();
    const track = tileOf(d, 'track');
    const maze = tileOf(d, 'maze');
    expect(track.x).toBe(14);
    expect(track.y).toBe(14);
    expect(maze.x - (track.x + track.width)).toBe(14);
    expect(maze.x + maze.width).toBe(METRICS.width - 14);
  });

  test('stored ratios are clamped to minimum sizes without being rewritten', () => {
    const root = split('row', 0.02, leaf('a'), leaf('b'));
    const { tiles, gutters } = layoutTree(root, METRICS);
    expect(tiles.get('a')?.width).toBeGreaterThanOrEqual(METRICS.minWidth);
    expect(gutters[0].ratio).toBeCloseTo(gutters[0].minRatio);
    expect(root.ratio).toBe(0.02);
  });
});

describe('dwindle insertion', () => {
  test('first window fills the workspace, next ones split the focused tile by aspect', () => {
    let d = desktopOf([createWorkspace('Empty')]);
    d = openWindow(d, windowOf('a'), METRICS);
    expect(d.workspaces[0].root).toEqual(leaf('a'));
    d = openWindow(d, windowOf('b'), METRICS);
    expect(d.workspaces[0].root).toEqual(split('row', 0.5, leaf('a'), leaf('b')));
    d = openWindow(d, windowOf('c'), METRICS);
    expect(d.workspaces[0].root).toEqual(
      split('row', 0.5, leaf('a'), split('column', 0.5, leaf('b'), leaf('c')))
    );
    d = openWindow(d, windowOf('d'), METRICS);
    expect(d.workspaces[0].root).toEqual(
      split(
        'row',
        0.5,
        leaf('a'),
        split('column', 0.5, leaf('b'), split('row', 0.5, leaf('c'), leaf('d')))
      )
    );
    expect(focusedWindow(d.workspaces[0])).toBe('d');
  });

  test('falls back to the largest tile when the focused one is too small to split', () => {
    const root = split(
      'row',
      0.5,
      leaf('big'),
      split('column', 0.5, leaf('x'), split('row', 0.5, leaf('tiny'), leaf('y')))
    );
    let d = desktopOf([createWorkspace('W', root, 'tiny')]);
    d = openWindow(d, windowOf('new'), { ...METRICS, minWidth: 380, minHeight: 300 });
    expect(leafIds(d.workspaces[0].root)).toEqual(['big', 'new', 'x', 'tiny', 'y']);
  });
});

describe('closing', () => {
  test('the sibling is promoted into the freed space', () => {
    let d = overview();
    const before = tileOf(d, 'track');
    d = closeWindow(d, 'robot');
    const ws = d.workspaces[0];
    expect(ws.root).toEqual(
      split('row', 0.6, leaf('track'), split('column', 0.6, leaf('maze'), leaf('profile')))
    );
    expect(tileOf(d, 'track').height).toBe(METRICS.height - 28);
    expect(tileOf(d, 'track').width).toBe(before.width);
    expect(focusedWindow(ws)).toBe('track');
    expect(d.windows.has('robot')).toBe(false);
  });

  test('closing the last window empties the workspace', () => {
    let d = openWindow(desktopOf([createWorkspace('W')]), windowOf('only'), METRICS);
    d = closeWindow(d, 'only');
    expect(d.workspaces[0].root).toBeNull();
    expect(focusedWindow(d.workspaces[0])).toBeNull();
  });
});

describe('directional focus and swap', () => {
  test('focus follows geometry, not tree order', () => {
    let d = overview();
    d = focusDirection(d, 'right', METRICS);
    expect(focusedWindow(d.workspaces[0])).toBe('maze');
    d = focusDirection(d, 'down', METRICS);
    expect(focusedWindow(d.workspaces[0])).toBe('profile');
    d = focusDirection(d, 'left', METRICS);
    expect(focusedWindow(d.workspaces[0])).toBe('robot');
    d = focusDirection(d, 'left', METRICS);
    expect(focusedWindow(d.workspaces[0])).toBe('robot');
  });

  test('swap exchanges tiles and keeps focus on the moved window', () => {
    let d = overview();
    const mazeTile = tileOf(d, 'maze');
    d = swapDirection(d, 'right', METRICS);
    expect(tileOf(d, 'track')).toEqual(mazeTile);
    expect(focusedWindow(d.workspaces[0])).toBe('track');
  });

  test('a maximized window covers the area and hides the others', () => {
    const d = toggleMaximize(overview());
    const layout = layoutWorkspace(d.workspaces[0], METRICS);
    expect(layout.windows.filter((w) => w.visible).map((w) => w.id)).toEqual(['track']);
    expect(layout.gutters).toHaveLength(0);
  });
});

describe('drag and drop', () => {
  test('dropping on an edge splits the target tile on that side', () => {
    const before = overview();
    const d = applyDrop(before, 'profile', edgeTarget(before, 'profile', 'track', 'left'), METRICS);
    expect(d.workspaces[0].root).toEqual(
      split(
        'row',
        0.6,
        split('column', 0.6, split('row', 0.5, leaf('profile'), leaf('track')), leaf('robot')),
        leaf('maze')
      )
    );
  });

  test('dropping on the center swaps', () => {
    const before = overview();
    const target = hitTest(before, 'profile', centerOf(tileOf(before, 'track')), METRICS);
    expect(target?.kind).toBe('center');
    const d = target === null ? before : applyDrop(before, 'profile', target, METRICS);
    expect(leafIds(d.workspaces[0].root)).toEqual(['profile', 'robot', 'maze', 'track']);
  });

  test('moving to another workspace shows it and places the window there', () => {
    const d = moveToWorkspace(overview(), 'maze', 1, METRICS);
    expect(d.active).toBe(1);
    expect(d.workspaces[1].root).toEqual(leaf('maze'));
    expect(leafIds(d.workspaces[0].root)).toEqual(['track', 'robot', 'profile']);
  });
});

describe('resizing', () => {
  test('ratios are clamped to minimum sizes and reset to 50/50', () => {
    let d = resizeSplit(overview(), '', 0.99, METRICS);
    const right = tileOf(d, 'maze');
    expect(right.width).toBeGreaterThanOrEqual(METRICS.minWidth);
    expect(right.width).toBeLessThan(METRICS.minWidth + 2);
    d = resetSplit(d, '', METRICS);
    const root = d.workspaces[0].root;
    expect(root?.type === 'split' && root.ratio).toBe(0.5);
  });
});

describe('floating layer', () => {
  test('toggling floats a window above the tiling and docks it back', () => {
    let d = toggleFloating(overview(), 'robot', METRICS);
    const ws = d.workspaces[0];
    expect(leafIds(ws.root)).toEqual(['track', 'maze', 'profile']);
    expect(ws.floating.map((f) => f.id)).toEqual(['robot']);
    d = toggleFloating(d, 'robot', METRICS);
    expect(d.workspaces[0].floating).toHaveLength(0);
    expect(leafIds(d.workspaces[0].root)).toContain('robot');
  });
});

describe('serialization', () => {
  test('a JSON round trip restores the exact layout', () => {
    let d = toggleFloating(resizeSplit(overview(), '0', 0.35, METRICS), 'profile', METRICS);
    d = toggleMaximize(moveToWorkspace(d, 'maze', 1, METRICS));
    const restored = restoreDesktop(JSON.parse(JSON.stringify(serializeDesktop(d))));
    expect(restored).toEqual(d);
  });

  test('malformed snapshots are rejected with a useful message', () => {
    const snapshot = JSON.parse(JSON.stringify(serializeDesktop(overview())));
    snapshot.workspaces[1].root = { type: 'leaf', id: 'track' };
    snapshot.workspaces[1].focus = ['track'];
    expect(() => restoreDesktop(snapshot)).toThrow(LayoutError);
    expect(() => restoreDesktop(snapshot)).toThrow(
      'workspaces[1].root.id places "track" a second time; it is already at workspaces[0].root.first.first.id'
    );
    expect(() => restoreDesktop({ ...snapshot, version: 99 })).toThrow(
      'version is 99, newer than 1, the latest known'
    );
  });
});
