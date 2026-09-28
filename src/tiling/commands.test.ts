import { describe, expect, test } from 'vitest';

import { METRICS, desktopOf, overview, windowOf } from './fixtures/desktops';
import {
  createWorkspace,
  execute,
  focusedWindow,
  isFloating,
  leaf,
  leafIds,
  split,
  type Command,
  type Desktop,
} from './index';

function run(desktop: Desktop<string>, ...commands: Command<string>[]): Desktop<string> {
  return commands.reduce((current, command) => execute(current, command, METRICS), desktop);
}

describe('commands', () => {
  test('focus and swap by direction', () => {
    const d = run(
      overview(),
      { type: 'focusDirection', direction: 'right' },
      { type: 'swapDirection', direction: 'down' }
    );
    expect(focusedWindow(d.workspaces[0])).toBe('maze');
    expect(leafIds(d.workspaces[0].root)).toEqual(['track', 'robot', 'profile', 'maze']);
  });

  test('act on the focused window unless another one is named', () => {
    const d = run(
      overview(),
      { type: 'toggleFloating' },
      { type: 'toggleFloating', id: 'maze' },
      { type: 'close', id: 'robot' }
    );
    expect(isFloating(d.workspaces[0], 'track')).toBe(true);
    expect(isFloating(d.workspaces[0], 'maze')).toBe(true);
    expect(d.windows.has('robot')).toBe(false);
  });

  test('move to a workspace, following by default', () => {
    const followed = run(overview(), { type: 'moveToWorkspace', index: 1 });
    expect(followed.active).toBe(1);
    expect(leafIds(followed.workspaces[1].root)).toEqual(['track']);
    const stayed = run(overview(), { type: 'moveToWorkspace', index: 1, follow: false });
    expect(stayed.active).toBe(0);
  });

  test('maximize, switch workspace, open and close', () => {
    let d = run(overview(), { type: 'toggleMaximize' });
    expect(d.workspaces[0].maximized).toBe('track');
    d = run(d, { type: 'switchWorkspace', index: 1 }, { type: 'open', window: windowOf('log') });
    expect(leafIds(d.workspaces[1].root)).toEqual(['log']);
    d = run(d, { type: 'open', window: windowOf('x'), at: { target: 'log', side: 'left' } });
    expect(leafIds(d.workspaces[1].root)).toEqual(['x', 'log']);
    d = run(d, { type: 'close' });
    expect(leafIds(d.workspaces[1].root)).toEqual(['log']);
  });

  test('with no window to act on, change nothing', () => {
    const empty = desktopOf([createWorkspace('Empty')]);
    for (const command of [
      { type: 'close' },
      { type: 'toggleFloating' },
      { type: 'toggleMaximize' },
      { type: 'moveToWorkspace', index: 0 },
      { type: 'focusDirection', direction: 'up' },
      { type: 'swapDirection', direction: 'left' },
    ] satisfies Command[]) {
      expect(execute(empty, command, METRICS)).toBe(empty);
    }
  });
});

describe('pointer and accessibility commands', () => {
  test('focus a window by id, and the next and previous in reading order', () => {
    let d = run(overview(), { type: 'focusWindow', id: 'profile' });
    expect(focusedWindow(d.workspaces[0])).toBe('profile');
    d = run(d, { type: 'focusNext' });
    expect(focusedWindow(d.workspaces[0])).toBe('track');
    d = run(d, { type: 'focusPrevious' }, { type: 'focusPrevious' });
    expect(focusedWindow(d.workspaces[0])).toBe('robot');
  });

  test('resize moves the nearest split along the direction and reset brings it back', () => {
    const root = split('row', 0.5, leaf('a'), split('column', 0.5, leaf('b'), leaf('c')));
    const d = desktopOf([createWorkspace('W', root, 'b')]);
    const wider = run(d, { type: 'resize', direction: 'left', step: 0.1 });
    expect(wider.workspaces[0].root).toMatchObject({ ratio: 0.4, second: { ratio: 0.5 } });
    const taller = run(d, { type: 'resize', direction: 'down', step: 0.1 });
    expect(taller.workspaces[0].root).toMatchObject({ ratio: 0.5, second: { ratio: 0.6 } });
    expect(run(wider, { type: 'resetSplit', path: '' }).workspaces[0].root).toEqual(root);
  });

  test('resize without a split along that axis changes nothing', () => {
    const d = desktopOf([createWorkspace('W', split('row', 0.5, leaf('a'), leaf('b')))]);
    expect(execute(d, { type: 'resize', direction: 'up', step: 0.1 }, METRICS)).toBe(d);
  });
});

describe('workspace commands', () => {
  test('add, rename, move and remove workspaces', () => {
    let d = run(
      overview(),
      { type: 'addWorkspace', name: 'Sensors', at: 0 },
      { type: 'renameWorkspace', index: 2, name: 'Plots' },
      { type: 'moveWorkspace', from: 0, to: 2 }
    );
    expect(d.workspaces.map((w) => w.name)).toEqual(['Overview', 'Plots', 'Sensors']);
    expect(d.active).toBe(0);
    d = run(d, { type: 'removeWorkspace', index: 0, policy: 'mergeIntoNeighbor' });
    expect(d.workspaces.map((w) => w.name)).toEqual(['Plots', 'Sensors']);
    expect(leafIds(d.workspaces[0].root)).toHaveLength(4);
  });
});
