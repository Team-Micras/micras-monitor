import { describe, expect, test } from 'vitest';

import { METRICS, desktopOf, overview, tileOf } from './fixtures/desktops';
import {
  closeWindow,
  createWorkspace,
  focusedWindow,
  focusWindow,
  leaf,
  moveToWorkspace,
  placeFloating,
  split,
  swapWindows,
  toggleFloating,
  toggleMaximize,
  usableBounds,
} from './index';

describe('lifting a window', () => {
  test('centres it on its tile at three quarters of the size and remembers the place', () => {
    const d = overview();
    const tile = tileOf(d, 'robot');
    const [entry] = toggleFloating(d, 'robot', METRICS).workspaces[0].floating;
    expect(entry.rect.width).toBe(Math.round(tile.width * 0.75));
    expect(entry.rect.x + entry.rect.width / 2).toBeCloseTo(tile.x + tile.width / 2, 0);
    expect(entry.dock).toEqual({ sibling: ['track'], side: 'bottom', ratio: 0.6 });
  });

  test('restores the tiling when the maximized window is lifted', () => {
    const d = toggleFloating(toggleMaximize(overview()), 'track', METRICS);
    expect(d.workspaces[0].maximized).toBeNull();
    expect(focusedWindow(d.workspaces[0])).toBe('track');
  });
});

describe('docking back', () => {
  test('returns a window to its previous place and ratio', () => {
    const d = overview();
    const back = toggleFloating(toggleFloating(d, 'robot', METRICS), 'robot', METRICS);
    expect(back.workspaces[0].root).toEqual(d.workspaces[0].root);
    expect(focusedWindow(back.workspaces[0])).toBe('robot');
  });

  test('returns a window beside the subtree it came from, even rearranged inside', () => {
    const root = split('row', 0.3, leaf('a'), split('column', 0.5, leaf('b'), leaf('c')));
    let d = desktopOf([createWorkspace('W', root)]);
    d = toggleFloating(d, 'a', METRICS);
    d = swapWindows(d, 'b', 'c');
    d = toggleFloating(d, 'a', METRICS);
    expect(d.workspaces[0].root).toEqual(
      split('row', 0.3, leaf('a'), split('column', 0.5, leaf('c'), leaf('b')))
    );
  });

  test('uses the dwindle rule on the tile under the window when the place is gone', () => {
    let d = toggleFloating(overview(), 'robot', METRICS);
    d = closeWindow(d, 'track');
    d = toggleFloating(d, 'robot', METRICS);
    expect(d.workspaces[0].root).toEqual(
      split('column', 0.6, leaf('maze'), split('row', 0.5, leaf('profile'), leaf('robot')))
    );
  });

  test('forgets the place when the window moves to another workspace', () => {
    let d = toggleFloating(overview(), 'robot', METRICS);
    const rect = d.workspaces[0].floating[0].rect;
    d = moveToWorkspace(d, 'robot', 1, METRICS);
    expect(d.workspaces[1].floating).toEqual([{ id: 'robot', rect, dock: null }]);
    d = toggleFloating(d, 'robot', METRICS);
    expect(d.workspaces[1].root).toEqual(leaf('robot'));
  });
});

function lifted() {
  return toggleFloating(overview(), 'robot', METRICS);
}

describe('moving and resizing a floating window', () => {
  test('keeps it inside the usable bounds and at least the minimum size', () => {
    const bounds = usableBounds(METRICS);
    const moved = placeFloating(
      lifted(),
      'robot',
      { x: -500, y: 2000, width: 10, height: 10 },
      METRICS
    );
    expect(moved.workspaces[0].floating[0].rect).toEqual({
      x: bounds.x,
      y: bounds.y + bounds.height - METRICS.minHeight,
      width: METRICS.minWidth,
      height: METRICS.minHeight,
    });
    const huge = placeFloating(
      lifted(),
      'robot',
      { x: 0, y: 0, width: 9999, height: 9999 },
      METRICS
    );
    expect(huge.workspaces[0].floating[0].rect).toEqual(bounds);
  });

  test('ignores tiled windows', () => {
    const d = lifted();
    expect(placeFloating(d, 'track', { x: 0, y: 0, width: 300, height: 300 }, METRICS)).toBe(d);
  });

  test('focusing a floating window raises it to the top', () => {
    let d = toggleFloating(lifted(), 'maze', METRICS);
    expect(d.workspaces[0].floating.map((f) => f.id)).toEqual(['robot', 'maze']);
    d = focusWindow(d, 'robot');
    expect(d.workspaces[0].floating.map((f) => f.id)).toEqual(['maze', 'robot']);
  });
});
