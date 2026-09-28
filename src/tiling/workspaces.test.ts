import { describe, expect, test } from 'vitest';

import { METRICS, desktopOf, overview } from './fixtures/desktops';
import {
  createWorkspace,
  focusedWindow,
  focusWindow,
  leaf,
  leafIds,
  moveToWorkspace,
  moveWindow,
  placeFloating,
  split,
  swapWindows,
  switchWorkspace,
  toggleFloating,
  toggleMaximize,
  workspaceOf,
} from './index';

describe('moving between workspaces', () => {
  test('keeps the window id and record, and focuses it on arrival', () => {
    const before = focusWindow(focusWindow(overview(), 'robot'), 'maze');
    const after = moveToWorkspace(before, 'maze', 1, METRICS);
    expect(after.windows.get('maze')).toBe(before.windows.get('maze'));
    expect(workspaceOf(after, 'maze')).toBe(1);
    expect(focusedWindow(after.workspaces[1])).toBe('maze');
    expect(focusedWindow(after.workspaces[0])).toBe('robot');
  });

  test('can stay on the current workspace', () => {
    const d = moveToWorkspace(overview(), 'maze', 1, METRICS, false);
    expect(d.active).toBe(0);
    expect(d.workspaces[1].root).toEqual(leaf('maze'));
  });

  test('places the window by the dwindle rule on the destination', () => {
    const d = moveToWorkspace(
      desktopOf([createWorkspace('A', leaf('a')), createWorkspace('B', leaf('b'))]),
      'a',
      1,
      METRICS
    );
    expect(d.workspaces[0].root).toBeNull();
    expect(d.workspaces[1].root).toEqual(split('row', 0.5, leaf('b'), leaf('a')));
  });

  test('clears a maximize the moved window held', () => {
    const d = moveToWorkspace(toggleMaximize(overview()), 'track', 1, METRICS);
    expect(d.workspaces[0].maximized).toBeNull();
  });

  test('does nothing for the same workspace, an unknown window or a missing workspace', () => {
    const d = overview();
    expect(moveToWorkspace(d, 'maze', 0, METRICS)).toBe(d);
    expect(moveToWorkspace(d, 'nobody', 1, METRICS)).toBe(d);
    expect(moveToWorkspace(d, 'maze', 7, METRICS)).toBe(d);
  });
});

describe('moving to the edge of another window', () => {
  test('keeps the id and can cross workspaces', () => {
    const before = desktopOf([
      createWorkspace('A', split('row', 0.5, leaf('a'), leaf('x'))),
      createWorkspace('B', leaf('b')),
    ]);
    const after = moveWindow(before, 'x', { target: 'b', side: 'top' });
    expect(after.windows.get('x')).toBe(before.windows.get('x'));
    expect(after.active).toBe(1);
    expect(after.workspaces[0].root).toEqual(leaf('a'));
    expect(after.workspaces[1].root).toEqual(split('column', 0.5, leaf('x'), leaf('b')));
  });

  test('does nothing onto itself or onto a window that is not tiled', () => {
    const d = overview();
    expect(moveWindow(d, 'maze', { target: 'maze', side: 'left' })).toBe(d);
    expect(moveWindow(d, 'maze', { target: 'nobody', side: 'left' })).toBe(d);
  });
});

describe('switching workspaces', () => {
  test('shows another workspace and ignores indices that name none', () => {
    const d = overview();
    expect(switchWorkspace(d, 1).active).toBe(1);
    expect(switchWorkspace(d, 2)).toBe(d);
    expect(switchWorkspace(d, -1)).toBe(d);
  });

  test('focusing a window on another workspace shows that workspace', () => {
    const d = focusWindow(moveToWorkspace(overview(), 'maze', 1, METRICS, false), 'maze');
    expect(d.active).toBe(1);
    expect(leafIds(d.workspaces[1].root)).toEqual(['maze']);
  });
});

describe('no-ops keep the same desktop', () => {
  test('swapping a window with itself', () => {
    const d = overview();
    expect(swapWindows(d, 'maze', 'maze')).toBe(d);
  });

  test('placing a floating window where it already is', () => {
    const d = toggleFloating(overview(), 'maze', METRICS);
    const { rect } = d.workspaces[0].floating[0];
    expect(placeFloating(d, 'maze', rect, METRICS)).toBe(d);
  });

  test('moving a window back to its place is equal, though not the same', () => {
    const d = overview();
    const back = moveWindow(d, 'robot', { target: 'track', side: 'bottom', share: 0.4 });
    expect(back).not.toBe(d);
    expect(back).toEqual(focusWindow(d, 'robot'));
  });
});
