import { afterEach, describe, expect, test } from 'vitest';
import { userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-react';

import { RobotRegistry } from '@/robot-kit';
import { mouse } from '@/robot-kit/fixtures/packages';
import { activeWorkspace, focusedWindow, leafIds, type Point } from '@/tiling';

import { App } from './app';
import { createDemoRobot } from './fake/demo-robot';
import { isTextField } from './keymap/use-keymap';
import type { MonitorPorts } from './ports';
import './styles.css';
import { createShellStore, type ShellStore } from './state/shell-store';

const STOP = 5;
const MICRAS = mouse({ id: 'micras', displayName: 'Micras' });

interface Setup {
  readonly store: ShellStore;
  readonly sent: number[];
  readonly screen: Awaited<ReturnType<typeof render>>;
}

async function setup(): Promise<Setup> {
  const robot = createDemoRobot({ connectMs: 5, handshakeMs: 5, commandMs: 5 });
  const sent: number[] = [];
  const ports: MonitorPorts = {
    ...robot.ports,
    commands: {
      send: (code, argument) => {
        sent.push(code);
        return robot.ports.commands.send(code, argument);
      },
    },
  };
  const store = createShellStore({ theme: 'dark' });
  const screen = await render(
    <App ports={ports} robots={new RobotRegistry([MICRAS])} store={store} synthetic />
  );
  await settle();
  return { store, sent, screen };
}

async function connect({ screen }: Setup): Promise<void> {
  await screen.getByRole('button', { name: 'Connect', exact: true }).click();
  await screen.getByRole('dialog').getByRole('button', { name: 'Connect' }).click();
  await expect.element(screen.getByText('· connected')).toBeVisible();
  await userEvent.keyboard('{Escape}');
  await expect.element(screen.getByRole('dialog')).not.toBeInTheDocument();
}

function activeIds(store: ShellStore): string[] {
  return leafIds(activeWorkspace(store.getState().desktop).root);
}

function focused(store: ShellStore): string | null {
  return focusedWindow(activeWorkspace(store.getState().desktop));
}

function element(selector: string): Element {
  const found = document.querySelector(selector);

  if (found === null) {
    throw new Error(`nothing matches ${selector}`);
  }

  return found;
}

function centerOf(target: Element, fx = 0.5, fy = 0.5): Point {
  const rect = target.getBoundingClientRect();
  return { x: rect.x + rect.width * fx, y: rect.y + rect.height * fy };
}

function fire(type: string, { x, y }: Point): void {
  const target = document.elementFromPoint(x, y) ?? document.body;
  target.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      composed: true,
      clientX: x,
      clientY: y,
      button: 0,
      buttons: type === 'pointerup' ? 0 : 1,
      pointerId: 1,
      pointerType: 'mouse',
      isPrimary: true,
    })
  );
}

async function drag(from: Point, to: Point): Promise<void> {
  fire('pointerdown', from);

  for (let step = 1; step <= 6; step += 1) {
    fire('pointermove', {
      x: from.x + ((to.x - from.x) * step) / 6,
      y: from.y + ((to.y - from.y) * step) / 6,
    });
  }

  fire('pointerup', to);
  await settle();
}

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 300));
}

afterEach(() => {
  localStorage.clear();
});

describe('connection', () => {
  test('connects to the fake robot and picks its package by name', async () => {
    const context = await setup();
    await connect(context);
    await context.screen.getByRole('button', { name: /WebSocket/ }).click();
    await expect.element(context.screen.getByText('Micras', { exact: true }).last()).toBeVisible();
    await expect.element(context.screen.getByText('3f9a1c07')).toBeVisible();
    await context.screen.getByRole('button', { name: 'Disconnect' }).click();
    await expect
      .element(context.screen.getByRole('button', { name: 'Connect' }).first())
      .toBeVisible();
  });
});

describe('keyboard', () => {
  test('focuses, swaps, maximizes, floats and closes windows', async () => {
    const { store, screen } = await setup();
    expect(focused(store)).toBe('tracking');

    await userEvent.keyboard('{Alt>}{ArrowRight}{/Alt}');
    expect(focused(store)).toBe('maze');
    await expect
      .element(screen.getByRole('region', { name: 'Maze' }))
      .toHaveAttribute('data-focused', 'true');

    await userEvent.keyboard('{Alt>}{Shift>}{ArrowLeft}{/Shift}{/Alt}');
    expect(activeIds(store).slice(0, 2)).toEqual(['maze', 'tracking']);

    await userEvent.keyboard('{Alt>}f{/Alt}');
    expect(activeWorkspace(store.getState().desktop).maximized).toBe('maze');
    await userEvent.keyboard('{Alt>}f{/Alt}');
    expect(activeWorkspace(store.getState().desktop).maximized).toBeNull();

    await userEvent.keyboard('{Alt>}o{/Alt}');
    expect(activeWorkspace(store.getState().desktop).floating.map((entry) => entry.id)).toEqual([
      'maze',
    ]);
    await userEvent.keyboard('{Alt>}o{/Alt}');
    expect(activeIds(store)).toContain('maze');

    await userEvent.keyboard('{Alt>}q{/Alt}');
    expect(store.getState().desktop.windows.has('maze')).toBe(false);
    await expect.element(screen.getByText('Tiling · 3 windows')).toBeVisible();
  });

  test('switches workspaces and sends windows to them', async () => {
    const { store, screen } = await setup();
    await userEvent.keyboard('{Alt>}2{/Alt}');
    await expect
      .element(screen.getByRole('tab', { name: 'Tracking' }))
      .toHaveAttribute('aria-selected', 'true');
    const moved = focused(store);
    await userEvent.keyboard('{Alt>}{Shift>}1{/Shift}{/Alt}');
    const { desktop } = store.getState();
    expect(desktop.active).toBe(1);
    expect(leafIds(desktop.workspaces[0].root)).toContain(moved);
    await expect.element(screen.getByText('Tiling · 1 window')).toBeVisible();
  });

  test('Space stops the robot without pressing the focused button, and types in text fields', async () => {
    const context = await setup();
    const { screen, sent, store } = context;
    await connect(context);

    const add = screen.getByRole('button', { name: 'Add a workspace' });
    const button = add.element();
    expect(button).toBeInstanceOf(HTMLElement);

    if (button instanceof HTMLElement) {
      button.focus();
    }

    await userEvent.keyboard(' ');
    expect(sent).toEqual([STOP]);
    expect(store.getState().desktop.workspaces).toHaveLength(4);

    await userEvent.keyboard('/');
    const search = screen.getByRole('searchbox', { name: 'Search the variables' });
    await expect.element(search).toHaveFocus();
    await userEvent.keyboard('batt ery');
    await expect.element(search).toHaveValue('batt ery');
    expect(sent).toEqual([STOP]);
  });

  test('P pauses the focused window', async () => {
    const { store, screen } = await setup();
    await userEvent.keyboard('p');
    expect(store.getState().paused.has('tracking')).toBe(true);
    await expect.element(screen.getByRole('button', { name: 'Resume Tracking' })).toBeVisible();
  });
});

describe('mouse', () => {
  test('dragging a title onto a window swaps them, onto an edge splits', async () => {
    const { store } = await setup();
    await drag(
      centerOf(element('[data-window="tracking"] h2')),
      centerOf(element('[data-window="maze"]'))
    );
    expect(activeIds(store)).toEqual(['maze', 'tracking', 'robot', 'commands']);

    await drag(
      centerOf(element('[data-window="commands"] h2')),
      centerOf(element('[data-window="maze"]'), 0.04, 0.5)
    );
    expect(activeIds(store)).toEqual(['commands', 'maze', 'tracking', 'robot']);
    expect(store.getState().drag).toBeNull();
  });

  test('dragging a title onto a workspace tab moves the window there', async () => {
    const { store, screen } = await setup();
    await drag(
      centerOf(element('[data-window="robot"] h2')),
      centerOf(element('[data-workspace-tab="2"]'))
    );
    expect(leafIds(store.getState().desktop.workspaces[2].root)).toContain('robot');
    await expect.element(screen.getByText('Tiling · 3 windows')).toBeVisible();
  });

  test('dragging a gap resizes the split', async () => {
    const { store } = await setup();
    const ratio = () => {
      const root = activeWorkspace(store.getState().desktop).root;
      return root?.type === 'split' ? root.ratio : Number.NaN;
    };
    const before = ratio();
    const start = centerOf(element('[data-gutter=""]'));
    await drag(start, { x: start.x, y: start.y - 150 });
    expect(ratio()).toBeLessThan(before - 0.1);
  });

  test('windows keep their elements when they move', async () => {
    const { store } = await setup();
    const maze = element('[data-window="maze"]');
    store.getState().run({ type: 'moveToWorkspace', index: 3, id: 'maze', follow: true });
    await new Promise((resolve) => requestAnimationFrame(resolve));
    expect(element('[data-window="maze"]')).toBe(maze);
  });
});

describe('launcher', () => {
  test('Ctrl+K opens a window by name', async () => {
    const { store, screen } = await setup();
    await userEvent.keyboard('{Control>}k{/Control}');
    await expect.element(screen.getByRole('dialog', { name: 'Launcher' })).toBeVisible();
    await userEvent.keyboard('Log');
    await userEvent.keyboard('{Enter}');
    await expect.element(screen.getByText('Tiling · 5 windows')).toBeVisible();
    const id = focused(store);
    expect(id === null ? null : store.getState().desktop.windows.get(id)?.kind).toBe('log');
  });

  test('runs workspace actions', async () => {
    const { store } = await setup();
    await userEvent.keyboard('{Control>}k{/Control}');
    await userEvent.keyboard('New workspace{Enter}');
    expect(store.getState().desktop.workspaces).toHaveLength(5);
    expect(store.getState().desktop.active).toBe(4);
  });
});

describe('variables drawer', () => {
  test('drags a variable into a window and onto an edge', async () => {
    const context = await setup();
    const { store, screen } = context;
    await connect(context);
    await userEvent.keyboard('/');
    await expect.element(screen.getByRole('complementary', { name: 'Variables' })).toBeVisible();
    await userEvent.keyboard('battery');

    const row = () => element('[data-variable="battery_voltage"]');
    await drag(centerOf(row()), centerOf(element('[data-window="tracking"]'), 0.66, 0.5));
    expect(store.getState().desktop.windows.get('tracking')?.payload.variables).toContain(
      'battery_voltage'
    );

    await drag(centerOf(row()), centerOf(element('[data-window="commands"]'), 0.04, 0.5));
    const ids = activeIds(store);
    expect(ids).toHaveLength(5);
    expect(store.getState().desktop.windows.get(ids[3])).toMatchObject({
      kind: 'plot',
      payload: { variables: ['battery_voltage'] },
    });
  });

  test('Escape closes it', async () => {
    const { store } = await setup();
    await userEvent.keyboard('/');
    expect(store.getState().overlay).toBe('drawer');
    await userEvent.keyboard('{Escape}');
    expect(store.getState().overlay).toBeNull();
  });
});

describe('theme', () => {
  test('toggles light and dark', async () => {
    const { screen } = await setup();
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    await screen.getByRole('button', { name: 'Use the light theme' }).click();
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });
});

test('isTextField tells text fields from other targets', () => {
  const text = document.createElement('input');
  const box = document.createElement('input');
  box.type = 'checkbox';
  const editable = document.createElement('div');
  editable.contentEditable = 'true';
  document.body.append(editable);
  expect(isTextField(text)).toBe(true);
  expect(isTextField(document.createElement('textarea'))).toBe(true);
  expect(isTextField(editable)).toBe(true);
  expect(isTextField(box)).toBe(false);
  expect(isTextField(document.createElement('button'))).toBe(false);
  expect(isTextField(null)).toBe(false);
  editable.remove();
});
