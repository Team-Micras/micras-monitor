import { describe, expect, test } from 'vitest';

import { METRICS, desktopOf, overview, windowOf } from './fixtures/desktops';
import {
  createWorkspace,
  execute,
  focusedWindow,
  isFloating,
  leafIds,
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
