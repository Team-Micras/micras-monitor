import { describe, expect, test } from 'vitest';

import { centreOf } from './geometry';
import { METRICS, overview, tileOf } from './fixtures/desktops';
import {
  applyDrop,
  focusedWindow,
  hitTest,
  leafIds,
  placeFloating,
  toggleFloating,
  toggleMaximize,
  type Desktop,
  type DropTarget,
} from './index';

function edgeOf(desktop: Desktop, dragged: string | null, id: string, dx: number, dy: number) {
  const centre = centreOf(tileOf(desktop, id));
  return hitTest(desktop, dragged, { x: centre.x + dx, y: centre.y + dy }, METRICS);
}

function expectEdge(target: DropTarget | null): Extract<DropTarget, { kind: 'edge' }> {
  expect(target?.kind).toBe('edge');

  if (target?.kind !== 'edge') {
    throw new Error('not an edge target');
  }

  return target;
}

describe('hit testing', () => {
  test('the centre of a tile means swap, previewed as that tile', () => {
    const d = overview();
    const target = hitTest(d, 'profile', centreOf(tileOf(d, 'track')), METRICS);
    expect(target).toEqual({ kind: 'center', id: 'track', preview: tileOf(d, 'track') });
  });

  test('an edge preview is the tile the window will take, the gap left out', () => {
    const d = overview();
    const track = tileOf(d, 'track');
    const target = expectEdge(edgeOf(d, 'profile', 'track', -track.width / 2 + 5, 0));
    expect(target.side).toBe('left');
    expect(target.preview).toEqual({
      x: track.x,
      y: track.y,
      width: Math.round((track.width - METRICS.gap) / 2),
      height: track.height,
    });
    const dropped = applyDrop(d, 'profile', target, METRICS);
    expect(tileOf(dropped, 'profile')).toEqual(target.preview);
    expect(tileOf(dropped, 'track').x - (target.preview.x + target.preview.width)).toBe(
      METRICS.gap
    );
  });

  test('an edge of the sibling previews the layout after the dragged window left', () => {
    const d = overview();
    const track = tileOf(d, 'track');
    const target = expectEdge(edgeOf(d, 'robot', 'track', 0, track.height / 2 - 5));
    expect(target.side).toBe('bottom');
    const dropped = applyDrop(d, 'robot', target, METRICS);
    expect(tileOf(dropped, 'robot')).toEqual(target.preview);
    expect(target.preview.height).toBe(Math.round((METRICS.height - 28 - METRICS.gap) / 2));
  });

  test('a new window from outside previews the tile it would open in', () => {
    const d = overview();
    const maze = tileOf(d, 'maze');
    const target = expectEdge(edgeOf(d, null, 'maze', 0, -maze.height / 2 + 5));
    expect(target.side).toBe('top');
    expect(target.preview).toEqual({
      ...maze,
      height: Math.round((maze.height - METRICS.gap) / 2),
    });
  });

  test('the dragged tile, the gaps and floating windows are not targets', () => {
    let d = overview();
    const track = tileOf(d, 'track');
    expect(hitTest(d, 'track', centreOf(track), METRICS)).toBeNull();
    expect(hitTest(d, 'robot', { x: track.x + track.width + 7, y: 200 }, METRICS)).toBeNull();
    d = toggleFloating(d, 'profile', METRICS);
    d = placeFloating(d, 'profile', { ...track, width: 300, height: 300 }, METRICS);
    expect(hitTest(d, 'maze', { x: track.x + 10, y: track.y + 10 }, METRICS)).toBeNull();
  });

  test('a maximized window is the only target', () => {
    const d = toggleMaximize(overview());
    const target = hitTest(d, null, { x: METRICS.width - 30, y: 400 }, METRICS);
    expect(target).toMatchObject({ kind: 'edge', id: 'track', side: 'right' });
  });
});

describe('applying a drop', () => {
  test('on a workspace tab moves the window without showing that workspace', () => {
    const d = applyDrop(overview(), 'maze', { kind: 'workspace', index: 1 }, METRICS);
    expect(d.active).toBe(0);
    expect(leafIds(d.workspaces[1].root)).toEqual(['maze']);
    expect(focusedWindow(d.workspaces[1])).toBe('maze');
  });

  test('on a centre swaps and focuses the dragged window', () => {
    const before = overview();
    const target = hitTest(before, 'profile', centreOf(tileOf(before, 'track')), METRICS);
    const d = target === null ? before : applyDrop(before, 'profile', target, METRICS);
    expect(tileOf(d, 'profile')).toEqual(tileOf(before, 'track'));
    expect(focusedWindow(d.workspaces[0])).toBe('profile');
  });
});
