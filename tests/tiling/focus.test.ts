import { describe, expect, test } from 'vitest';

import { METRICS, desktopOf, overview } from '@tests/support/tiling/desktops';
import {
  closeWindow,
  createWorkspace,
  findNeighbor,
  focusDirection,
  focusedWindow,
  focusWindow,
  layoutWorkspace,
  leaf,
  neighborOf,
  readingOrder,
  split,
  toggleMaximize,
  type Desktop,
  type Direction,
  type PlacedWindow,
  type Rect,
  type Workspace,
} from '@/tiling';

function tiled(id: string, rect: Rect): PlacedWindow {
  return { id, rect, floating: false, visible: true };
}

function floating(id: string, rect: Rect): PlacedWindow {
  return { id, rect, floating: true, visible: true };
}

function focusFrom(desktop: Desktop, from: string, direction: Direction): string | null {
  return neighborOf(focusWindow(desktop, from), direction, METRICS);
}

/**
 * ```
 * A | B | C
 * ---------
 *     D
 * ```
 */
function threeAboveOne(): Desktop {
  const top = split('row', 1 / 3, leaf('A'), split('row', 0.5, leaf('B'), leaf('C')));
  return desktopOf([createWorkspace('W', split('column', 0.5, top, leaf('D')))]);
}

function withFloating(workspace: Workspace, entries: readonly [string, Rect][]): Desktop {
  return desktopOf([
    {
      ...workspace,
      floating: entries.map(([id, rect]) => ({ id, rect, dock: null })),
    },
  ]);
}

describe('the edge rule between tiled windows', () => {
  test('A|B|C above a full-width D: down from any top window reaches D', () => {
    const d = threeAboveOne();
    expect(focusFrom(d, 'C', 'down')).toBe('D');
    expect(focusFrom(d, 'A', 'down')).toBe('D');
    expect(focusFrom(d, 'C', 'right')).toBeNull();
    expect(focusFrom(d, 'B', 'left')).toBe('A');
    expect(focusFrom(d, 'D', 'up')).toBe('B');
  });

  test('a candidate that overlaps on the other axis beats a nearer one that does not', () => {
    const windows = [
      tiled('O', { x: 0, y: 0, width: 100, height: 100 }),
      tiled('near', { x: 110, y: 200, width: 100, height: 100 }),
      tiled('far', { x: 300, y: 50, width: 100, height: 100 }),
    ];
    expect(findNeighbor(windows, 'O', 'right')).toBe('far');
  });

  test('among overlapping candidates the nearest edge wins over the closest center', () => {
    const windows = [
      tiled('O', { x: 0, y: 0, width: 100, height: 100 }),
      tiled('near', { x: 110, y: 80, width: 100, height: 100 }),
      tiled('aligned', { x: 300, y: 0, width: 100, height: 100 }),
    ];
    expect(findNeighbor(windows, 'O', 'right')).toBe('near');
  });

  test('among equally near edges the closest center wins', () => {
    const windows = [
      tiled('O', { x: 0, y: 100, width: 100, height: 100 }),
      tiled('high', { x: 110, y: 0, width: 100, height: 120 }),
      tiled('level', { x: 110, y: 130, width: 100, height: 100 }),
    ];
    expect(findNeighbor(windows, 'O', 'right')).toBe('level');
    expect(findNeighbor(windows, 'O', 'left')).toBeNull();
  });

  test('when centers tie, the most recently focused window wins', () => {
    const top = split('row', 0.5, leaf('A'), leaf('B'));
    const d = desktopOf([createWorkspace('W', split('column', 0.5, top, leaf('D')))]);
    const viaA = focusWindow(focusWindow(d, 'A'), 'D');
    const viaB = focusWindow(focusWindow(d, 'B'), 'D');
    expect(focusedWindow(focusDirection(viaA, 'up', METRICS).workspaces[0])).toBe('A');
    expect(focusedWindow(focusDirection(viaB, 'up', METRICS).workspaces[0])).toBe('B');
  });

  test('windows hidden behind a maximized one are not neighbors', () => {
    const d = toggleMaximize(overview());
    expect(focusDirection(d, 'right', METRICS)).toBe(d);
  });
});

describe('the center rule for floating windows', () => {
  const pair = createWorkspace('W', split('row', 0.5, leaf('a'), leaf('b')), 'a');
  const low = { x: 600, y: 560, width: 400, height: 200 };

  test('a tiled window prefers a tiled neighbor over a closer floating one', () => {
    const d = withFloating(pair, [['f', { x: 600, y: 300, width: 400, height: 200 }]]);
    expect(focusFrom(d, 'a', 'right')).toBe('b');
  });

  test('a tiled window reaches a floating one when no tiled window lies that way', () => {
    const d = withFloating(pair, [['f', low]]);
    expect(focusFrom(d, 'a', 'down')).toBe('f');
    expect(focusFrom(d, 'a', 'up')).toBeNull();
  });

  test('from a floating window, centers inside the cone come first, then the closest', () => {
    const d = withFloating(pair, [['f', low]]);
    expect(focusFrom(d, 'f', 'left')).toBe('a');
    expect(focusFrom(d, 'f', 'right')).toBe('b');
    expect(focusFrom(d, 'f', 'up')).toBe('a');
    expect(focusFrom(d, 'f', 'down')).toBeNull();
  });

  test('floating windows reach each other by their centers even when they overlap', () => {
    const windows = [
      tiled('t', { x: 0, y: 0, width: 1000, height: 400 }),
      floating('f', { x: 100, y: 100, width: 300, height: 300 }),
      floating('g', { x: 250, y: 150, width: 300, height: 300 }),
      floating('h', { x: 150, y: 600, width: 300, height: 300 }),
    ];
    expect(findNeighbor(windows, 'f', 'right')).toBe('g');
    expect(findNeighbor(windows, 'g', 'left')).toBe('f');
    expect(findNeighbor(windows, 'f', 'down')).toBe('h');
  });
});

describe('focus history', () => {
  test('closing the focused window focuses the previously focused one', () => {
    let d = focusWindow(focusWindow(overview(), 'robot'), 'maze');
    d = closeWindow(d, 'maze');
    expect(focusedWindow(d.workspaces[0])).toBe('robot');
  });

  test('closing another window leaves the focus alone', () => {
    const d = closeWindow(focusWindow(overview(), 'maze'), 'robot');
    expect(focusedWindow(d.workspaces[0])).toBe('maze');
  });

  test('with no history left, the promoted sibling takes the focus', () => {
    const root = split(
      'row',
      0.5,
      leaf('x'),
      split('column', 0.5, leaf('a'), split('row', 0.5, leaf('b'), leaf('c')))
    );
    const d = closeWindow(desktopOf([createWorkspace('W', root, 'a')]), 'a');
    expect(d.workspaces[0].focus).toEqual(['b']);
  });

  test('the history lists each window once, most recent first', () => {
    const d = focusWindow(focusWindow(focusWindow(overview(), 'maze'), 'robot'), 'maze');
    expect(d.workspaces[0].focus).toEqual(['maze', 'robot', 'track']);
  });
});

describe('reading order', () => {
  test('follows the screen, top edge first, not the tree', () => {
    const root = split(
      'row',
      0.3,
      split('column', 0.3, leaf('A'), leaf('B')),
      split('column', 0.6, leaf('C'), leaf('D'))
    );
    const layout = layoutWorkspace(createWorkspace('W', root), METRICS);
    expect(readingOrder(layout)).toEqual(['A', 'C', 'B', 'D']);
  });

  test('puts floating windows after the tiling and leaves hidden windows out', () => {
    const workspace: Workspace = {
      ...createWorkspace('W', split('row', 0.5, leaf('a'), leaf('b')), 'b'),
      floating: [
        { id: 'low', rect: { x: 100, y: 500, width: 300, height: 200 }, dock: null },
        { id: 'high', rect: { x: 900, y: 50, width: 300, height: 200 }, dock: null },
      ],
    };
    expect(readingOrder(layoutWorkspace(workspace, METRICS))).toEqual(['a', 'b', 'high', 'low']);
    expect(readingOrder(layoutWorkspace({ ...workspace, maximized: 'b' }, METRICS))).toEqual([
      'b',
      'high',
      'low',
    ]);
  });
});
