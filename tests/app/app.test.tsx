import type { ReactNode } from 'react';
import { afterEach, describe, expect, test } from 'vitest';
import { userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-react';

import { RobotRegistry, type RobotPackage } from '@/core/robot';
import { mouse } from '@tests/support/core/robot/packages';
import { activeWorkspace, focusedWindow, leafIds, type Point, type Rect } from '@/tiling';

import { App } from '@/app/app';
import { isTextField } from '@/app/keymap/use-keymap';
import type { AppMonitor } from '@/app/monitor-context';
import '@/app/styles.css';
import { createShellStore, type ShellStore } from '@/app/state/shell-store';
import type { CommandOutcome } from '@/core/source';
import type { DemoRobot } from '@/sources/demo/demo-source';
import { settled } from '@tests/support/app/animations';
import { recordCommandOutcomes } from '@tests/support/app/command-outcomes';
import { demoMonitor } from '@tests/support/sources/demo-monitor';

const STOP = 5;
const MICRAS = mouse({ id: 'micras', displayName: 'Micras' });

interface SetupOptions {
  readonly packages?: readonly RobotPackage<ReactNode>[];
  readonly robot?: Partial<DemoRobot>;
  readonly send?: (code: number) => Promise<CommandOutcome>;
  /** Lets the app create its own store, from what the browser remembers. */
  readonly remembered?: boolean;
}

interface Setup {
  readonly store: ShellStore | null;
  readonly monitor: AppMonitor;
  readonly sent: number[];
  readonly screen: Awaited<ReturnType<typeof render>>;
  /** Every text the Command outcome showed since the app came up. */
  readonly outcomes: () => string;
}

async function setup(options: SetupOptions = {}): Promise<Setup> {
  const sent: number[] = [];
  const monitor = demoMonitor({
    robot: options.robot,
    command: (code, argument, inner) => {
      sent.push(code);
      return options.send?.(code) ?? inner.command(code, argument);
    },
  });
  const store = options.remembered === true ? null : createShellStore({ theme: 'dark' });
  const screen = await render(
    <App
      monitor={monitor}
      robots={new RobotRegistry(options.packages ?? [MICRAS])}
      store={store ?? undefined}
      synthetic
    />
  );
  await expect.element(screen.getByRole('region', { name: 'Workspace Overview' })).toBeVisible();
  await settled();
  return {
    store,
    monitor,
    sent,
    screen,
    outcomes: recordCommandOutcomes(screen.getByRole('status', { name: 'Command outcome' })),
  };
}

function shell({ store }: Setup): ShellStore {
  if (store === null) {
    throw new Error('this setup lets the app own its store');
  }

  return store;
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

function floatingRect(store: ShellStore, id: string): Rect | undefined {
  return activeWorkspace(store.getState().desktop).floating.find((entry) => entry.id === id)?.rect;
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

function fire(type: string, { x, y }: Point, target?: Element): void {
  (target ?? document.elementFromPoint(x, y) ?? document.body).dispatchEvent(
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

function press(from: Point, to: Point): void {
  fire('pointerdown', from);

  for (let step = 1; step <= 6; step += 1) {
    fire('pointermove', {
      x: from.x + ((to.x - from.x) * step) / 6,
      y: from.y + ((to.y - from.y) * step) / 6,
    });
  }
}

async function drag(from: Point, to: Point): Promise<void> {
  press(from, to);
  fire('pointerup', to);
  await settled();
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

  test('the launcher opens the connection popover', async () => {
    const { screen } = await setup();
    await userEvent.keyboard('{Control>}k{/Control}');
    await expect.element(screen.getByRole('dialog', { name: 'Launcher' })).toBeVisible();
    await userEvent.keyboard('Connection{Enter}');
    await expect.element(screen.getByRole('dialog', { name: 'Launcher' })).not.toBeInTheDocument();
    await expect
      .element(screen.getByRole('dialog').getByRole('button', { name: 'Connect' }))
      .toBeVisible();
    await settled();
    await expect
      .element(screen.getByRole('dialog').getByRole('button', { name: 'Connect' }))
      .toBeVisible();
  });
});

describe('pinned commands and command keys', () => {
  test('Space stops the robot without pressing the focused button, and types in text fields', async () => {
    const context = await setup();
    const { screen, sent } = context;
    await connect(context);

    const add = screen.getByRole('button', { name: 'Add a workspace' });
    const button = add.element();

    if (button instanceof HTMLElement) {
      button.focus();
    }

    await userEvent.keyboard(' ');
    expect(sent).toEqual([STOP]);
    await expect.poll(context.outcomes).toContain('Stop accepted');
    expect(shell(context).getState().desktop.workspaces).toHaveLength(4);

    await userEvent.keyboard('{Shift>} {/Shift}');
    expect(sent).toEqual([STOP, STOP]);
    expect(shell(context).getState().desktop.workspaces).toHaveLength(4);

    await userEvent.keyboard('/');
    const search = screen.getByRole('searchbox', { name: 'Search the variables' });
    await expect.element(search).not.toHaveFocus();
    await userEvent.keyboard(' ');
    expect(sent).toEqual([STOP, STOP, STOP]);

    await userEvent.keyboard('batt ery');
    await expect.element(search).toHaveFocus();
    await expect.element(search).toHaveValue('batt ery');
    expect(sent).toEqual([STOP, STOP, STOP]);
  });

  test('come from the robot package: none before one was seen', async () => {
    const context = await setup();
    await userEvent.keyboard(' ');
    expect(context.sent).toEqual([]);
    await expect.poll(context.outcomes).toContain('No robot to send commands to');
    await expect
      .element(context.screen.getByRole('banner').getByRole('button', { name: /^Stop/ }))
      .not.toBeInTheDocument();
  });

  test('come from no package for a robot no package describes', async () => {
    const context = await setup({ packages: [] });
    await connect(context);
    await userEvent.keyboard(' ');
    expect(context.sent).toEqual([]);
    await expect.poll(context.outcomes).toContain('Space sends no command');
    await expect
      .element(context.screen.getByRole('banner').getByRole('button', { name: /^Stop/ }))
      .not.toBeInTheDocument();
  });

  test('stay once the robot is gone, disabled, and say there is no robot', async () => {
    const context = await setup();
    await connect(context);
    context.monitor.disconnect();
    await expect
      .element(context.screen.getByRole('banner').getByRole('button', { name: /^Stop/ }))
      .toBeDisabled();
    await userEvent.keyboard(' ');
    await expect.poll(context.outcomes).toContain('No robot to send Stop to');
    expect(context.sent).toEqual([]);
  });

  test('send any pinned command from the top bar, with its outcome', async () => {
    const context = await setup({
      packages: [
        mouse({
          id: 'micras',
          displayName: 'Micras',
          commands: [
            { code: 0, name: 'GO', label: 'Go', acceptedIn: 'any', pinned: true },
            { code: 5, name: 'STOP', label: 'Stop', acceptedIn: 'any' },
          ],
        }),
      ],
      robot: { answer: () => ({ status: 'refused', reason: 1 }) },
    });
    await connect(context);
    const banner = context.screen.getByRole('banner');
    await expect.element(banner.getByRole('button', { name: /^Stop/ })).not.toBeInTheDocument();
    await banner.getByRole('button', { name: /^Go/ }).click();

    expect(context.sent).toEqual([0]);
    await expect.poll(context.outcomes).toContain('Go refused: not idle');
  });

  test('send a command by the key its package gives, which the user can bind to another', async () => {
    const context = await setup({
      packages: [
        mouse({
          id: 'micras',
          displayName: 'Micras',
          commands: [{ code: 0, name: 'GO', label: 'Go', acceptedIn: 'any', key: 'G' }],
        }),
      ],
      robot: { answer: () => ({ status: 'ok', reason: 0 }) },
    });
    await connect(context);
    await userEvent.keyboard('g');
    expect(context.sent).toEqual([0]);
    await expect.poll(context.outcomes).toContain('Go accepted');

    shell(context)
      .getState()
      .setKeyOverrides({ 'command.GO': ['Alt+G'] });
    await userEvent.keyboard('g');
    expect(context.sent).toEqual([0]);
    await userEvent.keyboard('{Alt>}g{/Alt}');
    expect(context.sent).toEqual([0, 0]);
  });

  test('ask first for a pinned command with a confirmation', async () => {
    const context = await setup({
      packages: [
        mouse({
          id: 'micras',
          displayName: 'Micras',
          commands: [
            {
              code: 0,
              name: 'GO',
              label: 'Go',
              acceptedIn: 'any',
              pinned: true,
              confirm: 'Start the run?',
            },
          ],
        }),
      ],
    });
    await connect(context);
    await context.screen.getByRole('banner').getByRole('button', { name: /^Go/ }).click();
    const dialog = context.screen.getByRole('dialog');
    await expect.element(dialog).toHaveTextContent('Start the run?');
    expect(context.sent).toEqual([]);
    await settled();
    await dialog.getByRole('button', { name: 'Go' }).click();
    expect(context.sent).toEqual([0]);
  });

  test('shows a refusal with its reason in the package words', async () => {
    const context = await setup({
      robot: { answer: () => ({ status: 'refused', reason: 1 }) },
    });
    await connect(context);
    await userEvent.keyboard(' ');
    await expect.poll(context.outcomes).toContain('Stop refused: not idle');
  });

  test('shows a deferral and a failure', async () => {
    const answers: CommandOutcome[] = [
      { status: 'deferred', reason: 1 },
      { status: 'failed', message: 'The robot did not answer.' },
    ];
    const context = await setup({
      send: () => Promise.resolve(answers.shift() ?? { status: 'ok', reason: 0 }),
    });
    await connect(context);
    await userEvent.keyboard(' ');
    await expect.poll(context.outcomes).toContain('Stop deferred: not idle');
    await userEvent.keyboard(' ');
    await expect.poll(context.outcomes).toContain('Stop failed: The robot did not answer.');
  });

  test('is Space again the moment the launcher closes', async () => {
    const context = await setup();
    await connect(context);
    await userEvent.keyboard('{Control>}k{/Control}');
    await expect.element(context.screen.getByRole('dialog', { name: 'Launcher' })).toBeVisible();
    await userEvent.keyboard(' ');
    expect(context.sent).toEqual([]);
    await userEvent.keyboard('{Escape} ');
    expect(context.sent).toEqual([STOP]);
  });
});

describe('keyboard', () => {
  test('focuses, swaps, maximizes, floats and closes windows', async () => {
    const context = await setup();
    const store = shell(context);
    const { screen } = context;
    expect(focused(store)).toBe('tracking');

    await userEvent.keyboard('{Alt>}{ArrowRight}{/Alt}');
    expect(focused(store)).toBe('maze');
    const maze = screen.getByRole('region', { name: 'Maze' });
    await expect.element(maze).toHaveAttribute('data-focused', 'true');
    await expect.element(maze).toHaveFocus();

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
    const context = await setup();
    const store = shell(context);
    await userEvent.keyboard('{Alt>}2{/Alt}');
    await expect
      .element(context.screen.getByRole('tab', { name: 'Tracking' }))
      .toHaveAttribute('aria-selected', 'true');
    const moved = focused(store);
    await userEvent.keyboard('{Alt>}{Shift>}1{/Shift}{/Alt}');
    const { desktop } = store.getState();
    expect(desktop.active).toBe(1);
    expect(leafIds(desktop.workspaces[0].root)).toContain(moved);
    await expect.element(context.screen.getByText('Tiling · 1 window')).toBeVisible();
  });

  test('P pauses the focused window', async () => {
    const context = await setup();
    await userEvent.keyboard('p');
    expect(shell(context).getState().paused.has('tracking')).toBe(true);
    await expect
      .element(context.screen.getByRole('button', { name: 'Resume Tracking' }))
      .toBeVisible();
  });

  test('remembers rebound keys between visits', async () => {
    localStorage.setItem('micras-monitor/keymap', JSON.stringify({ drawer: ['V'] }));
    const { screen } = await setup({ remembered: true });
    await expect.element(screen.getByRole('button', { name: /Variables/ })).toHaveTextContent('V');
    await userEvent.keyboard('v');
    await expect.element(screen.getByRole('complementary', { name: 'Variables' })).toBeVisible();
  });
});

describe('mouse', () => {
  test('dragging a title onto a window swaps them, onto an edge splits', async () => {
    const context = await setup();
    const store = shell(context);
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

  test('the drop preview says where the window lands, and Escape cancels the drag', async () => {
    const context = await setup();
    const store = shell(context);
    const target = centerOf(element('[data-window="maze"]'));
    press(centerOf(element('[data-window="tracking"] h2')), target);
    await expect.element(context.screen.getByText('Swap with Maze')).toBeVisible();

    press(target, centerOf(element('[data-window="maze"]'), 0.5, 0.96));
    await expect.element(context.screen.getByText('Place below Maze')).toBeVisible();

    await userEvent.keyboard('{Escape}');
    expect(store.getState().drag).toBeNull();
    fire('pointerup', target);
    expect(activeIds(store)).toEqual(['tracking', 'maze', 'robot', 'commands']);
    await expect.element(context.screen.getByText('Swap with Maze')).not.toBeInTheDocument();
  });

  test('a drag ends when the window loses focus', async () => {
    const context = await setup();
    const store = shell(context);
    press(
      centerOf(element('[data-window="tracking"] h2')),
      centerOf(element('[data-window="maze"]'))
    );
    expect(store.getState().drag).not.toBeNull();
    window.dispatchEvent(new Event('blur'));
    expect(store.getState().drag).toBeNull();
    fire('pointerup', centerOf(element('[data-window="maze"]')));
    expect(activeIds(store)).toEqual(['tracking', 'maze', 'robot', 'commands']);
  });

  test('dragging a title onto a workspace tab moves the window there', async () => {
    const context = await setup();
    const store = shell(context);
    await drag(
      centerOf(element('[data-window="robot"] h2')),
      centerOf(element('[data-workspace-tab="2"]'))
    );
    expect(leafIds(store.getState().desktop.workspaces[2].root)).toContain('robot');
    await expect.element(context.screen.getByText('Tiling · 3 windows')).toBeVisible();
  });

  test('dragging a gap resizes the split', async () => {
    const context = await setup();
    const store = shell(context);
    const ratio = () => {
      const root = activeWorkspace(store.getState().desktop).root;
      return root?.type === 'split' ? root.ratio : Number.NaN;
    };
    const before = ratio();
    const start = centerOf(element('[data-gutter=""]'));
    await drag(start, { x: start.x, y: start.y - 150 });
    expect(ratio()).toBeLessThan(before - 0.1);
  });

  test('a floating window moves by its title and resizes by its corner', async () => {
    const context = await setup();
    const store = shell(context);
    await userEvent.keyboard('{Alt>}o{/Alt}');
    await settled();
    const start = floatingRect(store, 'tracking');
    expect(start).toBeDefined();

    const title = centerOf(element('[data-window="tracking"] h2'));
    await drag(title, { x: title.x + 120, y: title.y + 60 });
    const moved = floatingRect(store, 'tracking');
    expect(moved?.x).toBe((start?.x ?? 0) + 120);
    expect(moved?.y).toBe((start?.y ?? 0) + 60);

    const handle = element('[data-window="tracking"] [data-resize-handle]');
    const corner = centerOf(handle);
    fire('pointerdown', corner, handle);
    fire('pointermove', { x: corner.x + 80, y: corner.y + 40 });
    fire('pointerup', { x: corner.x + 80, y: corner.y + 40 });
    await settled();
    const resized = floatingRect(store, 'tracking');
    expect(resized?.width).toBe((moved?.width ?? 0) + 80);
    expect(resized?.height).toBe((moved?.height ?? 0) + 40);
  });

  test('windows keep their elements when they move, float, maximize and swap', async () => {
    const context = await setup();
    const store = shell(context);
    const maze = element('[data-window="maze"]');
    const same = () => expect(element('[data-window="maze"]')).toBe(maze);

    store.getState().run({ type: 'focusWindow', id: 'maze' });
    await userEvent.keyboard('{Alt>}o{/Alt}');
    same();
    await userEvent.keyboard('{Alt>}o{/Alt}');
    same();
    await userEvent.keyboard('{Alt>}f{/Alt}');
    same();
    await userEvent.keyboard('{Alt>}f{/Alt}{Alt>}{Shift>}{ArrowLeft}{/Shift}{/Alt}');
    expect(activeIds(store)[0]).toBe('maze');
    same();
    store.getState().run({ type: 'moveToWorkspace', index: 3, id: 'maze', follow: true });
    await settled();
    same();
  });

  test('floating windows stay below the drawer', async () => {
    const context = await setup();
    await userEvent.keyboard('{Alt>}o{/Alt}/');
    const drawer = element('[data-drawer]');
    await expect
      .element(context.screen.getByRole('complementary', { name: 'Variables' }))
      .toBeVisible();
    await settled();
    const { x, y } = centerOf(drawer, 0.5, 0.3);
    expect(document.elementFromPoint(x, y)?.closest('[data-drawer]')).toBe(drawer);
    expect(getComputedStyle(element('[data-tiling]')).isolation).toBe('isolate');
    expect(floatingRect(shell(context), 'tracking')).toBeDefined();
  });
});

describe('launcher', () => {
  test('Ctrl+K opens a window by name', async () => {
    const context = await setup();
    await userEvent.keyboard('{Control>}k{/Control}');
    await expect.element(context.screen.getByRole('dialog', { name: 'Launcher' })).toBeVisible();
    await userEvent.keyboard('Log');
    await userEvent.keyboard('{Enter}');
    await expect.element(context.screen.getByText('Tiling · 5 windows')).toBeVisible();
    const store = shell(context);
    const id = focused(store);
    expect(id === null ? null : store.getState().desktop.windows.get(id)?.kind).toBe('log');
  });

  test('runs workspace actions', async () => {
    const context = await setup();
    await userEvent.keyboard('{Control>}k{/Control}');
    await userEvent.keyboard('New workspace{Enter}');
    const store = shell(context);
    expect(store.getState().desktop.workspaces).toHaveLength(5);
    expect(store.getState().desktop.active).toBe(4);
  });
});

describe('variables drawer', () => {
  test('drags a variable into a window and onto an edge', async () => {
    const context = await setup();
    const store = shell(context);
    const { screen } = context;
    await connect(context);
    await userEvent.keyboard('/');
    await expect.element(screen.getByRole('complementary', { name: 'Variables' })).toBeVisible();
    await userEvent.keyboard('battery');

    const row = () => element('[data-variable="battery_voltage"]');
    press(centerOf(row()), centerOf(element('[data-window="tracking"]'), 0.66, 0.5));
    await expect.element(screen.getByText('Add to Tracking')).toBeVisible();
    fire('pointerup', centerOf(element('[data-window="tracking"]'), 0.66, 0.5));
    await settled();
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

  test('a variable dropped on a floating plot joins it', async () => {
    const context = await setup();
    const store = shell(context);
    await connect(context);
    await userEvent.keyboard('{Alt>}o{/Alt}');
    store.getState().placeFloating('tracking', { x: 700, y: 200, width: 420, height: 300 });
    await userEvent.keyboard('/');
    await settled();
    await userEvent.keyboard('battery');
    const target = centerOf(element('[data-window="tracking"]'));
    await drag(centerOf(element('[data-variable="battery_voltage"]')), target);
    expect(store.getState().desktop.windows.get('tracking')?.payload.variables).toContain(
      'battery_voltage'
    );
  });

  test('a drag released on its own row adds nothing', async () => {
    const context = await setup();
    const store = shell(context);
    await connect(context);
    await userEvent.keyboard('/');
    await userEvent.keyboard('battery');
    const row = element('[data-variable="battery_voltage"]');
    const start = centerOf(row);
    await drag(start, { x: start.x + 40, y: start.y });
    fire('pointermove', start);
    fire('pointerup', start);

    if (row instanceof HTMLElement) {
      row.click();
    }

    expect(store.getState().desktop.windows.get('tracking')?.payload.variables).not.toContain(
      'battery_voltage'
    );
    expect(store.getState().desktop.windows.size).toBe(11);

    if (row instanceof HTMLElement) {
      row.click();
    }

    expect(store.getState().desktop.windows.get('tracking')?.payload.variables).toContain(
      'battery_voltage'
    );
  });

  test('/ in an empty search closes it, and Escape too', async () => {
    const context = await setup();
    const store = shell(context);
    await userEvent.keyboard('/');
    expect(store.getState().overlay).toBe('drawer');
    await userEvent.keyboard('a');
    const search = context.screen.getByRole('searchbox', { name: 'Search the variables' });
    await expect.element(search).toHaveFocus();
    await userEvent.keyboard('{Backspace}/');
    expect(store.getState().overlay).toBeNull();

    await userEvent.keyboard('/');
    expect(store.getState().overlay).toBe('drawer');
    await userEvent.keyboard('{Escape}');
    expect(store.getState().overlay).toBeNull();
  });
});

describe('placeholders', () => {
  test('ask for variables only in windows that take them', async () => {
    const context = await setup();
    const store = shell(context);
    store.getState().openWindow('plot');
    store.getState().openWindow('log');
    await expect
      .element(context.screen.getByText('Drag a variable here from the drawer'))
      .toBeVisible();
    await expect
      .element(context.screen.getByRole('region', { name: 'Log' }).last())
      .not.toHaveTextContent('Drag a variable');
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
