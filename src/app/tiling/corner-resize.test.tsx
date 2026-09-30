import { afterEach, describe, expect, test } from 'vitest';

import { createWorkspace, leaf, nodeAt, split } from '@/tiling';

import { settled } from '../fixtures/animations';
import { drag, pointIn, press, release } from '../fixtures/mouse';
import { mountShell, shellWindow, shownWorkspace, type ShellApp } from '../fixtures/shell-app';
import { TILING_SPACING, type ShellStore } from '../state/shell-store';
import '../styles.css';

const apps: ShellApp[] = [];

afterEach(async () => {
  await release();
  apps.splice(0).forEach(({ robot }) => robot.disconnect());
});

async function open(): Promise<ShellApp> {
  const app = await mountShell(
    [
      createWorkspace(
        'Grid',
        split(
          'row',
          0.5,
          split('column', 0.5, leaf('a'), leaf('b')),
          split('column', 0.5, leaf('c'), leaf('d'))
        )
      ),
    ],
    ['a', 'b', 'c', 'd'].map((id) => shellWindow(id, 'log'))
  );
  apps.push(app);
  return app;
}

function ratio(store: ShellStore, path: string): number {
  const node = nodeAt(shownWorkspace(store).root, path);
  return node?.type === 'split' ? node.ratio : Number.NaN;
}

function corner(name: string): HTMLElement {
  const found = document.querySelector<HTMLElement>(`[data-corner="${name}"]`);

  if (found === null) {
    throw new Error(`no corner ${name}`);
  }

  return found;
}

function windowRect(id: string): DOMRect {
  return document.querySelector(`[data-window="${id}"]`)?.getBoundingClientRect() ?? new DOMRect();
}

describe('dragging the corner of a tiled window', () => {
  test('shows a diagonal resize cursor where two gaps meet', async () => {
    await open();
    expect(getComputedStyle(corner('a bottom-right')).cursor).toBe('nwse-resize');
    expect(getComputedStyle(corner('b top-right')).cursor).toBe('nesw-resize');
    expect(getComputedStyle(corner('c bottom-left')).cursor).toBe('nesw-resize');
    expect(getComputedStyle(corner('d top-left')).cursor).toBe('nwse-resize');
    expect(document.querySelector('[data-corner="a top-left"]')).toBeNull();
  });

  test('resizes both splits at once, live, and its neighbors with it', async () => {
    const { store } = await open();
    const before = windowRect('a');
    const from = pointIn(corner('a bottom-right'));
    await press(from, { x: from.x + 120, y: from.y + 90 });
    await expect.poll(() => store.getState().resizing).toBe(true);
    await expect.poll(() => Math.round(windowRect('a').width - before.width)).toBe(120);
    expect(Math.round(windowRect('a').height - before.height)).toBe(90);
    expect(Math.round(windowRect('c').left - windowRect('a').right)).toBe(TILING_SPACING.gap);
    expect(Math.round(windowRect('b').top - windowRect('a').bottom)).toBe(TILING_SPACING.gap);
    await release();
    expect(store.getState().resizing).toBe(false);
    expect(ratio(store, '')).toBeGreaterThan(0.5);
    expect(ratio(store, '0')).toBeGreaterThan(0.5);
    expect(ratio(store, '1')).toBe(0.5);
  });

  test('from the corner of the window below, moves the same two gaps', async () => {
    const { store } = await open();
    const from = pointIn(corner('b top-right'));
    await drag(from, { x: from.x - 100, y: from.y - 60 });
    expect(ratio(store, '')).toBeLessThan(0.5);
    expect(ratio(store, '0')).toBeLessThan(0.5);
    expect(ratio(store, '1')).toBe(0.5);
  });

  test('stops at the minimum size of every window', async () => {
    await open();
    await settled();
    const from = pointIn(corner('d top-left'));
    await drag(from, { x: from.x + 2000, y: from.y + 2000 });
    await settled();
    expect(Math.round(windowRect('d').width)).toBe(TILING_SPACING.minWidth);
    expect(Math.round(windowRect('d').height)).toBe(TILING_SPACING.minHeight);
    expect(Math.round(windowRect('c').height)).toBeGreaterThan(TILING_SPACING.minHeight);
  });
});
