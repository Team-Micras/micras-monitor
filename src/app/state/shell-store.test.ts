import { describe, expect, test } from 'vitest';

import {
  activeWorkspace,
  centerOf,
  createDesktop,
  createWorkspace,
  focusedWindow,
  layoutWorkspace,
  leafIds,
  type Rect,
  type WindowId,
} from '@/tiling';

import { createShellStore, type ShellStore } from './shell-store';

const VIEWPORT: Rect = { x: 0, y: 64, width: 1400, height: 800 };
const TILING = { tab: null, overTiling: true } as const;

function store(): ShellStore {
  return createShellStore({ viewport: VIEWPORT, theme: 'dark' });
}

function rectOf(shell: ShellStore, id: WindowId): Rect {
  const { desktop, metrics } = shell.getState();
  const placed = layoutWorkspace(activeWorkspace(desktop), metrics).windows.find(
    (window) => window.id === id
  );

  if (placed === undefined) {
    throw new Error(`${id} is not on the active workspace`);
  }

  return placed.rect;
}

function client(shell: ShellStore, point: { x: number; y: number }) {
  const { origin } = shell.getState();
  return { x: point.x + origin.x, y: point.y + origin.y };
}

function leftEdgeOf(rect: Rect) {
  return { x: rect.x + 10, y: rect.y + rect.height / 2 };
}

describe('the default desktop', () => {
  test('opens on Overview with four windows', () => {
    const { desktop } = store().getState();
    expect(desktop.workspaces.map((workspace) => workspace.name)).toEqual([
      'Overview',
      'Tracking',
      'Sensors',
      'Maze run',
    ]);
    expect(leafIds(activeWorkspace(desktop).root)).toEqual([
      'tracking',
      'maze',
      'robot',
      'commands',
    ]);
  });
});

describe('windows', () => {
  test('openWindow gives a new id and focuses the window', () => {
    const shell = store();
    const first = shell.getState().openWindow('plot', ['pose/x']);
    const second = shell.getState().openWindow('plot');
    expect(first).not.toBe(second);
    expect(shell.getState().desktop.windows.get(first)?.payload.variables).toEqual(['pose/x']);
    expect(focusedWindow(activeWorkspace(shell.getState().desktop))).toBe(second);
  });

  test('addVariable adds a name once', () => {
    const shell = store();
    shell.getState().addVariable('tracking', 'pose/x');
    const desktop = shell.getState().desktop;
    shell.getState().addVariable('tracking', 'pose/x');
    expect(shell.getState().desktop).toBe(desktop);
    expect(desktop.windows.get('tracking')?.payload.variables).toContain('pose/x');
  });

  test('run keeps the desktop when a command changes nothing', () => {
    const shell = store();
    const desktop = shell.getState().desktop;
    shell.getState().run({ type: 'switchWorkspace', index: 0 });
    expect(shell.getState().desktop).toBe(desktop);
  });

  test('addWorkspace picks a free name and shows the workspace', () => {
    const shell = store();
    shell.getState().run({ type: 'renameWorkspace', index: 3, name: 'Workspace 5' });
    shell.getState().addWorkspace();
    const { desktop } = shell.getState();
    expect(desktop.workspaces.map((workspace) => workspace.name).at(-1)).toBe('Workspace 6');
    expect(desktop.active).toBe(4);
  });

  test('togglePause pauses and resumes', () => {
    const shell = store();
    shell.getState().togglePause('maze');
    expect(shell.getState().paused.has('maze')).toBe(true);
    shell.getState().togglePause('maze');
    expect(shell.getState().paused.has('maze')).toBe(false);
  });
});

describe('viewport, theme and overlays', () => {
  test('setViewport only changes on a new rect', () => {
    const shell = store();
    const before = shell.getState();
    shell.getState().setViewport(VIEWPORT);
    expect(shell.getState()).toBe(before);
    shell.getState().setViewport({ ...VIEWPORT, width: 1000 });
    expect(shell.getState().metrics.width).toBe(1000);
  });

  test('toggleTheme flips the theme', () => {
    const shell = store();
    shell.getState().toggleTheme();
    expect(shell.getState().theme).toBe('light');
  });

  test('setOverlay opens one overlay and toggles it closed', () => {
    const shell = store();
    shell.getState().setOverlay('drawer', true);
    expect(shell.getState().overlay).toBe('drawer');
    shell.getState().setOverlay('launcher', true);
    expect(shell.getState().overlay).toBe('launcher');
    shell.getState().setOverlay('launcher', true);
    expect(shell.getState().overlay).toBeNull();
  });

  test('setKeyOverrides rebinds', () => {
    const shell = store();
    shell.getState().setKeyOverrides({ stop: ['Ctrl+Space'] });
    expect(shell.getState().bindings.get('stop')?.[0]?.ctrl).toBe(true);
  });
});

describe('dragging a window', () => {
  test('onto the center of another swaps them', () => {
    const shell = store();
    const maze = rectOf(shell, 'maze');
    shell.getState().beginDrag({ kind: 'window', id: 'tracking' }, { x: 0, y: 0 });
    shell.getState().moveDrag(client(shell, centerOf(maze)), TILING);
    expect(shell.getState().drag?.target).toMatchObject({ kind: 'center', id: 'maze' });
    shell.getState().endDrag();
    expect(shell.getState().drag).toBeNull();
    expect(leafIds(activeWorkspace(shell.getState().desktop).root).slice(0, 2)).toEqual([
      'maze',
      'tracking',
    ]);
  });

  test('onto an edge splits that tile', () => {
    const shell = store();
    shell.getState().beginDrag({ kind: 'window', id: 'commands' }, { x: 0, y: 0 });
    shell.getState().moveDrag(client(shell, leftEdgeOf(rectOf(shell, 'tracking'))), TILING);
    expect(shell.getState().drag?.target).toMatchObject({ kind: 'edge', side: 'left' });
    shell.getState().endDrag();
    expect(leafIds(activeWorkspace(shell.getState().desktop).root)).toEqual([
      'commands',
      'tracking',
      'maze',
      'robot',
    ]);
  });

  test('onto a workspace tab moves it there without following', () => {
    const shell = store();
    shell.getState().beginDrag({ kind: 'window', id: 'maze' }, { x: 0, y: 0 });
    shell.getState().moveDrag({ x: 700, y: 20 }, { tab: 2, overTiling: false });
    expect(shell.getState().drag?.target).toEqual({ kind: 'workspace', index: 2 });
    shell.getState().endDrag();
    const { desktop } = shell.getState();
    expect(desktop.active).toBe(0);
    expect(leafIds(desktop.workspaces[2].root)).toContain('maze');
  });

  test('over its own tab or outside of the tiling has no target', () => {
    const shell = store();
    shell.getState().beginDrag({ kind: 'window', id: 'maze' }, { x: 0, y: 0 });
    shell.getState().moveDrag({ x: 700, y: 20 }, { tab: 0, overTiling: false });
    expect(shell.getState().drag?.target).toBeNull();
    shell.getState().moveDrag({ x: 700, y: 20 }, { tab: null, overTiling: false });
    expect(shell.getState().drag?.target).toBeNull();
    const desktop = shell.getState().desktop;
    shell.getState().endDrag();
    expect(shell.getState().desktop).toBe(desktop);
  });

  test('a floating window follows the pointer', () => {
    const shell = store();
    shell.getState().run({ type: 'toggleFloating', id: 'commands' });
    const start = rectOf(shell, 'commands');
    const grab = client(shell, { x: start.x + 20, y: start.y + 10 });
    shell.getState().beginDrag({ kind: 'window', id: 'commands' }, grab);
    shell.getState().moveDrag({ x: grab.x - 50, y: grab.y - 40 }, TILING);
    const moved = rectOf(shell, 'commands');
    expect(moved.x).toBe(start.x - 50);
    expect(moved.y).toBe(start.y - 40);
    shell.getState().cancelDrag();
    expect(shell.getState().drag).toBeNull();
  });
});

describe('dragging a variable', () => {
  test('onto a plot adds it there', () => {
    const shell = store();
    shell.getState().beginDrag({ kind: 'variable', name: 'pose/x' }, { x: 0, y: 0 });
    shell.getState().moveDrag(client(shell, centerOf(rectOf(shell, 'tracking'))), TILING);
    shell.getState().endDrag();
    expect(shell.getState().desktop.windows.get('tracking')?.payload.variables).toContain('pose/x');
  });

  test('onto the center of a window that takes no variables has no target', () => {
    const shell = store();
    shell.getState().beginDrag({ kind: 'variable', name: 'pose/x' }, { x: 0, y: 0 });
    shell.getState().moveDrag(client(shell, centerOf(rectOf(shell, 'commands'))), TILING);
    expect(shell.getState().drag?.target).toBeNull();
  });

  test('onto an edge opens a plot beside the window', () => {
    const shell = store();
    shell.getState().beginDrag({ kind: 'variable', name: 'pose/x' }, { x: 0, y: 0 });
    shell.getState().moveDrag(client(shell, leftEdgeOf(rectOf(shell, 'commands'))), TILING);
    shell.getState().endDrag();
    const ids = leafIds(activeWorkspace(shell.getState().desktop).root);
    expect(ids).toHaveLength(5);
    const opened = shell.getState().desktop.windows.get(ids[3]);
    expect(opened).toMatchObject({ kind: 'plot', payload: { variables: ['pose/x'] } });
  });

  test('onto an empty workspace opens a plot', () => {
    const shell = createShellStore({
      viewport: VIEWPORT,
      desktop: createDesktop([createWorkspace('Empty')]),
    });
    shell.getState().beginDrag({ kind: 'variable', name: 'pose/x' }, { x: 0, y: 0 });
    shell.getState().moveDrag({ x: 400, y: 400 }, TILING);
    expect(shell.getState().drag?.target).toMatchObject({ kind: 'new' });
    shell.getState().endDrag();
    expect(shell.getState().desktop.windows.size).toBe(1);
  });
});

test('resizeSplit moves a split within its minimums', () => {
  const shell = store();
  shell.getState().resizeSplit('', 0.3);
  expect(activeWorkspace(shell.getState().desktop).root).toMatchObject({ ratio: 0.3 });
  shell.getState().resizeSplit('', 0.001);
  const root = activeWorkspace(shell.getState().desktop).root;
  expect(root?.type === 'split' && root.ratio > 0.1).toBe(true);
});
