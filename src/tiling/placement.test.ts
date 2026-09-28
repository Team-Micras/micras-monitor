import { describe, expect, test } from 'vitest';

import { METRICS, desktopOf, overview, tileOf, windowOf } from './fixtures/desktops';
import {
  createWorkspace,
  dwindlePlacement,
  focusedWindow,
  focusWindow,
  leaf,
  LayoutError,
  openWindow,
  split,
  toggleFloating,
  toggleMaximize,
} from './index';

describe('dwindle placement', () => {
  test('uses the shorter side of a lone tile before breaking the minimum', () => {
    const d = openWindow(desktopOf([createWorkspace('W', leaf('a'))]), windowOf('b'), {
      ...METRICS,
      minWidth: 900,
    });
    expect(d.workspaces[0].root).toEqual(split('column', 0.5, leaf('a'), leaf('b')));
  });

  test('falls back to the largest tile whose longer side fits', () => {
    const root = split(
      'row',
      0.3,
      leaf('a'),
      split('row', 0.5, leaf('b'), split('column', 0.5, leaf('c'), leaf('d')))
    );
    const workspace = createWorkspace('W', root, 'd');
    expect(dwindlePlacement(workspace, { ...METRICS, minWidth: 300 })).toEqual({
      target: 'b',
      side: 'bottom',
    });
  });

  test('then to the shorter side, anchor first and then by area', () => {
    const root = split(
      'row',
      0.5,
      split('column', 0.5, leaf('a'), leaf('b')),
      split('column', 0.7, leaf('c'), leaf('d'))
    );
    const workspace = createWorkspace('W', root, 'd');
    expect(dwindlePlacement(workspace, { ...METRICS, minWidth: 400, minHeight: 250 })).toEqual({
      target: 'c',
      side: 'bottom',
    });
    expect(dwindlePlacement(workspace, { ...METRICS, minWidth: 400, minHeight: 100 })).toEqual({
      target: 'd',
      side: 'bottom',
    });
  });

  test('splits the anchor anyway when no tile can host a window', () => {
    const tiny = { ...METRICS, width: 300, height: 200 };
    const d = openWindow(desktopOf([createWorkspace('W', leaf('a'))]), windowOf('b'), tiny);
    expect(d.workspaces[0].root).toEqual(split('row', 0.5, leaf('a'), leaf('b')));
    expect(tileOf(d, 'a', tiny).width).toBe(tileOf(d, 'b', tiny).width);
  });

  test('anchors on the most recently focused tiled window while a floating one has the focus', () => {
    let d = focusWindow(overview(), 'profile');
    d = toggleFloating(d, 'robot', METRICS);
    expect(focusedWindow(d.workspaces[0])).toBe('robot');
    expect(dwindlePlacement(d.workspaces[0], METRICS)?.target).toBe('profile');
  });

  test('has nothing to split on an empty workspace', () => {
    expect(dwindlePlacement(createWorkspace('W'), METRICS)).toBeNull();
  });
});

describe('opening windows', () => {
  test('can go to an explicit edge of a target', () => {
    const d = openWindow(overview(), windowOf('x'), METRICS, { target: 'maze', side: 'top' });
    expect(d.workspaces[0].root).toEqual(
      split(
        'row',
        0.6,
        split('column', 0.6, leaf('track'), leaf('robot')),
        split('column', 0.6, split('column', 0.5, leaf('x'), leaf('maze')), leaf('profile'))
      )
    );
    expect(focusedWindow(d.workspaces[0])).toBe('x');
  });

  test('beside a tile of another workspace, that workspace is shown', () => {
    const d = openWindow(
      desktopOf([createWorkspace('A', leaf('a')), createWorkspace('B', leaf('b'))]),
      windowOf('x'),
      METRICS,
      { target: 'b', side: 'left' }
    );
    expect(d.active).toBe(1);
    expect(d.workspaces[1].root).toEqual(split('row', 0.5, leaf('x'), leaf('b')));
  });

  test('beside a window that is not tiled, falls back to the dwindle rule', () => {
    const floated = toggleFloating(overview(), 'robot', METRICS);
    const d = openWindow(floated, windowOf('x'), METRICS, { target: 'robot', side: 'left' });
    expect(d.workspaces[0].floating.map((f) => f.id)).toEqual(['robot']);
    expect(d.workspaces[0].root).toEqual(
      openWindow(floated, windowOf('x'), METRICS).workspaces[0].root
    );
  });

  test('restores a maximized workspace so the new window is visible', () => {
    const d = openWindow(toggleMaximize(overview()), windowOf('x'), METRICS);
    expect(d.workspaces[0].maximized).toBeNull();
  });

  test('rejects an id that is taken or empty, and an empty kind', () => {
    expect(() => openWindow(overview(), windowOf('maze'), METRICS)).toThrow(
      new LayoutError('window.id', '"maze" is already open')
    );
    expect(() => openWindow(overview(), windowOf(''), METRICS)).toThrow(
      'window.id must be a non-empty string'
    );
    expect(() => openWindow(overview(), { id: 'x', kind: '', payload: null }, METRICS)).toThrow(
      'window.kind must be a non-empty string'
    );
  });
});
