import { describe, expect, test } from 'vitest';

import { METRICS, desktopOf, overview } from '@tests/support/tiling/desktops';
import {
  addWorkspace,
  createWorkspace,
  focusedWindow,
  leaf,
  leafIds,
  moveWorkspace,
  neighborWorkspace,
  removeWorkspace,
  renameWorkspace,
  split,
  switchWorkspace,
  toggleFloating,
  type Desktop,
} from '@/tiling';

function names(desktop: Desktop): string[] {
  return desktop.workspaces.map((workspace) => workspace.name);
}

function four(active: number): Desktop<string> {
  return desktopOf(
    [
      createWorkspace('A', leaf('a')),
      createWorkspace('B', split('row', 0.5, leaf('b1'), leaf('b2'))),
      createWorkspace('C', leaf('c')),
      createWorkspace('D'),
    ],
    active
  );
}

describe('adding workspaces', () => {
  test('appends by default without showing the new one', () => {
    const d = addWorkspace(overview(), 'Sensors');
    expect(names(d)).toEqual(['Overview', 'Tracking', 'Sensors']);
    expect(d.active).toBe(0);
    expect(d.workspaces[2]).toEqual(createWorkspace('Sensors'));
  });

  test('inserting before the active workspace keeps it shown', () => {
    const d = addWorkspace(switchWorkspace(overview(), 1), 'First', 0);
    expect(names(d)).toEqual(['First', 'Overview', 'Tracking']);
    expect(d.active).toBe(2);
  });

  test('rejects an empty name', () => {
    expect(() => addWorkspace(overview(), '')).toThrow('name must be a non-empty string');
  });
});

describe('renaming and reordering', () => {
  test('rename changes only the name', () => {
    const before = overview();
    const d = renameWorkspace(before, 1, 'Plots');
    expect(names(d)).toEqual(['Overview', 'Plots']);
    expect(d.workspaces[0]).toBe(before.workspaces[0]);
    expect(renameWorkspace(before, 5, 'Nowhere')).toBe(before);
  });

  test('moving keeps the shown workspace shown, wherever it ends up', () => {
    expect(moveWorkspace(four(0), 0, 3)).toMatchObject({ active: 3 });
    expect(names(moveWorkspace(four(0), 0, 3))).toEqual(['B', 'C', 'D', 'A']);
    expect(moveWorkspace(four(2), 0, 3).active).toBe(1);
    expect(moveWorkspace(four(2), 3, 0).active).toBe(3);
    expect(moveWorkspace(four(1), 3, 2).active).toBe(1);
    const d = four(0);
    expect(moveWorkspace(d, 1, 9)).toBe(d);
  });
});

describe('removing workspaces', () => {
  test('closing the windows drops them from the desktop', () => {
    const d = removeWorkspace(four(3), 1, 'closeWindows', METRICS);
    expect(names(d)).toEqual(['A', 'C', 'D']);
    expect([...d.windows.keys()]).toEqual(['a', 'c']);
    expect(d.active).toBe(2);
  });

  test('merging moves the windows into the neighbor before it by the dwindle rule', () => {
    const d = removeWorkspace(four(0), 1, 'mergeIntoNeighbor', METRICS);
    expect(names(d)).toEqual(['A', 'C', 'D']);
    expect(d.workspaces[0].root).toEqual(
      split('row', 0.5, leaf('a'), split('column', 0.5, leaf('b1'), leaf('b2')))
    );
    expect(d.workspaces[0].focus).toEqual(['a', 'b1', 'b2']);
    expect(focusedWindow(d.workspaces[0])).toBe('a');
    expect(d.windows.size).toBe(4);
  });

  test('the first workspace merges into the one after it, which is then shown', () => {
    const d = removeWorkspace(four(0), 0, 'mergeIntoNeighbor', METRICS);
    expect(names(d)).toEqual(['B', 'C', 'D']);
    expect(d.active).toBe(0);
    expect(leafIds(d.workspaces[0].root)).toEqual(['b1', 'a', 'b2']);
  });

  test('floating windows merge with their rects', () => {
    let d = toggleFloating(four(2), 'c', METRICS);
    const { rect } = d.workspaces[2].floating[0];
    d = removeWorkspace(d, 2, 'mergeIntoNeighbor', METRICS);
    expect(d.workspaces[1].floating).toEqual([{ id: 'c', rect, dock: null }]);
    expect(d.active).toBe(1);
  });

  test('merging into a chosen workspace moves the windows there and shows it', () => {
    const d = removeWorkspace(four(1), 1, { mergeInto: 2 }, METRICS);
    expect(names(d)).toEqual(['A', 'C', 'D']);
    expect(leafIds(d.workspaces[1].root)).toEqual(['c', 'b1', 'b2']);
    expect(d.active).toBe(1);
    const shown = removeWorkspace(four(3), 0, { mergeInto: 3 }, METRICS);
    expect(names(shown)).toEqual(['B', 'C', 'D']);
    expect(leafIds(shown.workspaces[2].root)).toEqual(['a']);
    expect(shown.active).toBe(2);
  });

  test('merging into itself or into no workspace changes nothing', () => {
    const d = four(0);
    expect(removeWorkspace(d, 1, { mergeInto: 1 }, METRICS)).toBe(d);
    expect(removeWorkspace(d, 1, { mergeInto: 7 }, METRICS)).toBe(d);
  });

  test('the neighbor is the workspace before, or the one after the first', () => {
    expect(neighborWorkspace(0)).toBe(1);
    expect(neighborWorkspace(3)).toBe(2);
  });

  test('the last workspace and unknown indices stay', () => {
    const single = desktopOf([createWorkspace('Only', leaf('x'))]);
    expect(removeWorkspace(single, 0, 'closeWindows', METRICS)).toBe(single);
    const d = four(0);
    expect(removeWorkspace(d, 4, 'closeWindows', METRICS)).toBe(d);
  });
});
