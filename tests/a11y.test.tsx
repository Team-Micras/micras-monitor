/// <reference types="@vitest/browser-playwright" />
import { afterEach, describe, expect, test } from 'vitest';
import { cdp, userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-react';

import { RobotRegistry } from '@/robot-kit';
import {
  createDesktop,
  createWorkspace,
  focusedWindow,
  activeWorkspace,
  leaf,
  split,
  type Desktop,
  type TileNode,
} from '@/tiling';

import { micras } from '@robots/micras';

import { App } from '@/app/app';
import { DEMO_VARIABLES, createDemoRobot } from '@/app/fake/demo-robot';
import type { FakeRobot } from '@/app/fake/fake-robot';
import type { CommandOutcome, MonitorPorts } from '@/app/ports';
import { describeRobot } from '@/app/sessions/browser-sessions';
import { MemorySessionLibrary } from '@/app/sessions/memory-library';
import { MemoryLocks } from '@/app/sessions/session-library';
import { SessionManager } from '@/app/sessions/session-manager';
import { createShellStore, type ShellStore } from '@/app/state/shell-store';
import type { Theme } from '@/app/state/theme';
import '@/app/styles.css';
import type { AppUpdates } from '@/app/pwa/app-updates';
import type { ShellWindow, WindowPayload } from '@/app/windows/types';
import { seriousViolations } from '@tests/support/axe-check';
import { ManualScheduler } from '@/telemetry';

const IDLE = 1;
const RUN = 3;

const robots: FakeRobot[] = [];
const state = { value: IDLE };

afterEach(async () => {
  robots.splice(0).forEach((robot) => robot.disconnect());
  await cdp().send('Emulation.setEmulatedMedia', { features: [] });
});

function log(id: string, title: string): ShellWindow {
  return { id, kind: 'log', payload: { title, variables: [] } };
}

interface Options {
  readonly theme?: Theme;
  readonly windows?: readonly ShellWindow[];
  readonly root?: TileNode;
  readonly send?: (code: number) => Promise<CommandOutcome> | undefined;
  readonly sessions?: boolean;
  readonly desktop?: Desktop<WindowPayload>;
  readonly updates?: AppUpdates;
}

async function open(options: Options = {}) {
  state.value = IDLE;
  const [first, ...others] = DEMO_VARIABLES;
  const robot = createDemoRobot({
    connectMs: 5,
    handshakeMs: 10,
    configureMs: 5,
    commandMs: 5,
    tickMs: 20,
    variables: [{ ...first, signal: () => state.value }, ...others],
  });
  robots.push(robot);
  const ports: MonitorPorts = {
    ...robot.ports,
    commands: {
      send: (code, argument) => options.send?.(code) ?? robot.ports.commands.send(code, argument),
    },
  };
  const sessions =
    options.sessions === true
      ? new SessionManager({
          store: robot.store,
          library: new MemorySessionLibrary(),
          locks: new MemoryLocks(),
          scheduler: new ManualScheduler(),
          describe: () => describeRobot(robot.ports),
        })
      : undefined;
  await sessions?.start();
  const store: ShellStore = createShellStore({
    theme: options.theme ?? 'dark',
    desktop:
      options.desktop ??
      (options.windows === undefined || options.root === undefined
        ? undefined
        : createDesktop([createWorkspace('Test', options.root)], options.windows)),
  });
  const screen = await render(
    <App
      ports={ports}
      robots={new RobotRegistry([micras])}
      store={store}
      sessions={sessions}
      updates={options.updates}
      synthetic
    />
  );
  await expect.element(screen.getByRole('region', { name: /^Workspace / })).toBeVisible();
  return { robot, store, screen, sessions };
}

async function linked(options: Options = {}) {
  const opened = await open(options);
  opened.robot.connect({ transport: 'websocket', url: 'ws://robot' });
  await expect.element(opened.screen.getByText('· connected')).toBeVisible();
  return opened;
}

function blurActive(): void {
  if (document.activeElement instanceof HTMLElement) {
    document.activeElement.blur();
  }
}

async function tabThrough(presses: number, visit: (active: Element | null) => void): Promise<void> {
  if (presses > 0) {
    await userEvent.tab();
    visit(document.activeElement);
    await tabThrough(presses - 1, visit);
  }
}

function announced(politeness: 'polite' | 'assertive'): string {
  return document.querySelector(`[data-announcer="${politeness}"]`)?.textContent ?? '';
}

function windowOf(element: Element | null): string | null {
  return element?.closest('[data-window]')?.getAttribute('data-window') ?? null;
}

function separators(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('[role="separator"][data-gutter]')];
}

const THREE = {
  windows: [log('bottom', 'Bottom'), log('top', 'Top'), log('left', 'Left')],
  root: split('row', 0.5, leaf('left'), split('column', 0.5, leaf('top'), leaf('bottom'))),
};

describe('keyboard order and landmarks', () => {
  test('Tab reaches the tiles by position, then the splitters, then the floating windows', async () => {
    const { store } = await open({
      windows: [...THREE.windows, log('float', 'Float')],
      root: split(
        'row',
        0.5,
        leaf('left'),
        split('column', 0.5, leaf('top'), split('column', 0.5, leaf('bottom'), leaf('float')))
      ),
    });
    store.getState().run({ type: 'toggleFloating', id: 'float' });
    await expect.poll(() => document.querySelector('[data-window="float"]')).not.toBeNull();

    blurActive();
    const seen: string[] = [];
    await tabThrough(80, (active) => {
      const token = active?.getAttribute('role') === 'separator' ? 'splitter' : windowOf(active);

      if (token !== null && seen.at(-1) !== token) {
        seen.push(token);
      }
    });

    expect(seen.slice(0, 6)).toEqual(['left', 'top', 'bottom', 'splitter', 'float', 'left']);
  });

  test('every window is a region named by its title', async () => {
    const { screen } = await open({ ...THREE });

    await Promise.all(
      ['Left', 'Top', 'Bottom'].map(async (title) => {
        await expect.element(screen.getByRole('region', { name: title })).toBeVisible();
      })
    );
  });
});

describe('splitters', () => {
  test('are focusable separators with a value, moved by the arrows, Home and End', async () => {
    const { store } = await open({ ...THREE });
    const [first] = separators();

    expect(first.getAttribute('aria-orientation')).toBe('vertical');
    expect(first.tabIndex).toBe(0);
    first.focus();
    expect(first.getAttribute('aria-valuenow')).toBe('50');
    const min = Number(first.getAttribute('aria-valuemin'));
    const max = Number(first.getAttribute('aria-valuemax'));
    expect(min).toBeLessThan(50);
    expect(max).toBeGreaterThan(50);

    await userEvent.keyboard('{ArrowRight}');
    expect(first.getAttribute('aria-valuenow')).toBe('52');
    await userEvent.keyboard('{Shift>}{ArrowLeft}{/Shift}');
    expect(first.getAttribute('aria-valuenow')).toBe('42');
    await userEvent.keyboard('{Home}');
    expect(Number(first.getAttribute('aria-valuenow'))).toBe(min);
    await userEvent.keyboard('{End}');
    expect(Number(first.getAttribute('aria-valuenow'))).toBe(max);
    await userEvent.keyboard('{Enter}');
    expect(first.getAttribute('aria-valuenow')).toBe('50');

    const root = activeWorkspace(store.getState().desktop).root;
    expect(root?.type === 'split' ? root.ratio : null).toBeCloseTo(0.5, 2);
  });

  test('a horizontal splitter answers to the vertical arrows', async () => {
    await open({ ...THREE });
    const horizontal = separators().find(
      (element) => element.getAttribute('aria-orientation') === 'horizontal'
    );
    horizontal?.focus();
    await userEvent.keyboard('{ArrowDown}');
    expect(horizontal?.getAttribute('aria-valuenow')).toBe('52');
    await userEvent.keyboard('{ArrowRight}');
    expect(horizontal?.getAttribute('aria-valuenow')).toBe('52');
  });
});

describe('announcements', () => {
  test('say the connection and the robot state once, not every sample', async () => {
    const { robot } = await linked();
    await expect.poll(() => announced('polite')).toBe('Connected to micras');

    state.value = RUN;
    await expect.poll(() => announced('polite')).toBe('Robot state: RUN');
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(announced('polite')).toBe('Robot state: RUN');

    robot.disconnect();
    await expect.poll(() => announced('polite')).toBe('Disconnected');
  });

  test('say the outcome of STOP assertively', async () => {
    await linked();
    await userEvent.keyboard(' ');
    await expect.poll(() => announced('assertive')).toBe('Stop accepted');
  });

  test('say why STOP was refused', async () => {
    await linked({ send: () => Promise.resolve({ status: 'refused', reason: 1 }) });
    await userEvent.keyboard(' ');
    await expect.poll(() => announced('assertive')).toMatch(/^Stop refused/);
  });

  test('say a command refusal with its reason', async () => {
    const { screen } = await linked();
    state.value = RUN;
    await expect.poll(() => announced('polite')).toBe('Robot state: RUN');

    await screen.getByRole('button', { name: 'Explore', exact: true }).click();
    await expect.poll(() => announced('polite')).toMatch(/refused.*not idle/i);
  });

  test('say when recording starts and stops', async () => {
    const { screen } = await linked({ sessions: true });
    await screen.getByRole('button', { name: /^Recording, / }).click();
    await screen.getByRole('button', { name: 'Start recording' }).click();
    await expect.poll(() => announced('polite')).toBe('Recording started');

    await screen.getByRole('button', { name: /^Recording, / }).click();
    await screen.getByRole('button', { name: 'Stop recording' }).click();
    await expect.poll(() => announced('polite')).toBe('Recording stopped');
  });
});

describe('announcements of accepted commands', () => {
  test('say that a command was accepted', async () => {
    const { screen } = await linked();
    await screen.getByRole('button', { name: 'Explore', exact: true }).click();
    await expect.poll(() => announced('polite')).toBe('Explore accepted');
  });
});

function body(id: string): HTMLElement {
  const found = document.querySelector<HTMLElement>(`[data-window="${id}"] > .min-h-0`);

  if (found === null) {
    throw new Error(`no window ${id}`);
  }

  return found;
}

function scrolled(ids: readonly string[]): void {
  for (const id of ids) {
    const element = body(id);
    const tall = document.createElement('div');
    tall.style.height = '3000px';
    element.style.overflow = 'auto';
    element.append(tall);
    element.scrollTop = 120;
    expect(element.scrollTop).toBe(120);
  }
}

function frame(): Promise<unknown> {
  return new Promise((resolve) => requestAnimationFrame(resolve));
}

describe('moving windows', () => {
  const TWO = createDesktop(
    [createWorkspace('One', THREE.root), createWorkspace('Two', leaf('other'))],
    [...THREE.windows, log('other', 'Other')]
  );

  test('a swap keeps every window mounted, scrolled and animating', async () => {
    const { store } = await open({ desktop: TWO });
    scrolled(['left', 'top']);
    store.getState().run({ type: 'focusWindow', id: 'left' });
    store.getState().run({ type: 'swapDirection', direction: 'right' });
    await frame();

    expect(body('left').scrollTop).toBe(120);
    expect(body('top').scrollTop).toBe(120);
    expect(document.querySelector('[data-window="left"]')?.getAnimations().length).toBeGreaterThan(
      0
    );
  });

  test('a round trip through another workspace keeps their scroll', async () => {
    const { store } = await open({ desktop: TWO });
    scrolled(['left', 'top', 'bottom']);
    store.getState().run({ type: 'switchWorkspace', index: 1 });
    await frame();
    store.getState().run({ type: 'switchWorkspace', index: 0 });
    await frame();

    expect(['left', 'top', 'bottom'].map((id) => body(id).scrollTop)).toEqual([120, 120, 120]);
  });
});

describe('overlays', () => {
  test('Escape closes the launcher and returns the focus to where it came from', async () => {
    const { screen } = await open();
    const opener = screen
      .getByRole('button', { name: /^Pause / })
      .first()
      .element();
    opener.focus();

    await userEvent.keyboard('{Control>}k{/Control}');
    await expect.element(screen.getByRole('dialog')).toBeVisible();
    await userEvent.tab();
    await userEvent.tab({ shift: true });
    expect(document.activeElement?.closest('[role="dialog"]')).not.toBeNull();

    await userEvent.keyboard('{Escape}');
    await expect.element(screen.getByRole('dialog')).not.toBeInTheDocument();
    await expect.poll(() => document.activeElement).toBe(opener);
  });

  test('Escape closes the drawer and returns the focus, which Tab cannot leave', async () => {
    const { screen } = await open();
    const opener = screen
      .getByRole('button', { name: /^Pause / })
      .first()
      .element();
    opener.focus();

    await userEvent.keyboard('/');
    await expect.element(screen.getByRole('complementary', { name: 'Variables' })).toBeVisible();
    expect(document.activeElement?.closest('[data-drawer]')).not.toBeNull();

    await tabThrough(40, (active) => expect(active?.closest('[data-drawer]')).not.toBeNull());

    await userEvent.tab({ shift: true });
    expect(document.activeElement?.closest('[data-drawer]')).not.toBeNull();

    await userEvent.keyboard('{Escape}');
    await expect
      .element(screen.getByRole('complementary', { name: 'Variables' }))
      .not.toBeInTheDocument();
    await expect.poll(() => document.activeElement).toBe(opener);
  });

  test('P pauses the focused window with the drawer open, but types in the search', async () => {
    const { screen, store } = await open();
    const focused = () => focusedWindow(activeWorkspace(store.getState().desktop));

    await userEvent.keyboard('/');
    await expect.element(screen.getByRole('complementary', { name: 'Variables' })).toBeVisible();
    await userEvent.keyboard('p');
    const id = focused();
    expect(id).not.toBeNull();
    expect(store.getState().paused.has(id ?? '')).toBe(true);
    expect(screen.getByRole('searchbox').element()).toHaveProperty('value', '');

    screen.getByRole('searchbox').element().focus();
    await userEvent.keyboard('p');
    expect(screen.getByRole('searchbox').element()).toHaveProperty('value', 'p');
    expect(store.getState().paused.has(id ?? '')).toBe(true);
  });
});

function indicated(element: Element): boolean {
  const style = getComputedStyle(element);
  return (
    (style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0) ||
    style.boxShadow !== 'none'
  );
}

function transitionSeconds(): number {
  const element = document.querySelector('[data-window]');

  if (element === null) {
    throw new Error('no window on screen');
  }

  return parseFloat(getComputedStyle(element).transitionDuration);
}

describe('focus', () => {
  test('every control the keyboard reaches shows where the focus is', async () => {
    await linked();
    blurActive();
    const bare: string[] = [];
    const reached = new Set<Element>();
    await tabThrough(120, (active) => {
      if (active !== null && active !== document.body && !reached.has(active)) {
        reached.add(active);

        if (!indicated(active)) {
          bare.push(`${active.tagName.toLowerCase()} ${active.getAttribute('aria-label')}`);
        }
      }
    });

    expect(reached.size).toBeGreaterThan(15);
    expect(bare).toEqual([]);
  });
});

describe('motion', () => {
  test('windows animate their moves, unless the user prefers reduced motion', async () => {
    await open(THREE);
    expect(transitionSeconds()).toBeGreaterThan(0.1);

    await cdp().send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
    });
    await expect.poll(transitionSeconds).toBeLessThan(0.001);
  });
});

describe('axe', () => {
  for (const theme of ['dark', 'light'] as const) {
    test(`the ${theme} workspace, linked, has no serious violation`, async () => {
      await linked({ theme });
      state.value = IDLE;
      await new Promise((resolve) => setTimeout(resolve, 800));
      expect(await seriousViolations()).toEqual([]);
    });

    test(`the ${theme} launcher and drawer have none`, async () => {
      const { screen } = await linked({ theme });
      await userEvent.keyboard('{Control>}k{/Control}');
      await expect.element(screen.getByRole('dialog')).toBeVisible();
      expect(await seriousViolations()).toEqual([]);
      await userEvent.keyboard('{Escape}');
      await expect.element(screen.getByRole('dialog')).not.toBeInTheDocument();

      await userEvent.keyboard('/');
      await expect.element(screen.getByRole('complementary', { name: 'Variables' })).toBeVisible();
      expect(await seriousViolations()).toEqual([]);
    });
  }

  test('the connection and confirmation dialogs have none', async () => {
    const { screen, robot } = await open();
    await screen.getByRole('button', { name: 'Connect', exact: true }).click();
    await expect.element(screen.getByRole('dialog')).toBeVisible();
    expect(await seriousViolations()).toEqual([]);
    await userEvent.keyboard('{Escape}');

    robot.connect({ transport: 'websocket', url: 'ws://robot' });
    await expect.element(screen.getByText('· connected')).toBeVisible();
    state.value = IDLE;
    await screen.getByRole('button', { name: 'Save', exact: true }).click();
    await expect.element(screen.getByRole('dialog')).toBeVisible();
    expect(await seriousViolations()).toEqual([]);
  });

  const EVERY_KIND: ShellWindow[] = [
    { id: 'plot', kind: 'plot', payload: { title: 'Speed', variables: ['imu/gyro_z'] } },
    { id: 'readouts', kind: 'readouts', payload: { variables: ['imu/gyro_z', 'battery_voltage'] } },
    { id: 'editor', kind: 'editor', payload: { variables: ['run_profile'] } },
    { id: 'maze', kind: 'type-view', payload: { variables: ['maze'] } },
    { id: 'robot', kind: 'robot', payload: { variables: [] } },
    { id: 'commands', kind: 'commands', payload: { variables: [] } },
    { id: 'log', kind: 'log', payload: { variables: [] } },
    { id: 'link', kind: 'link', payload: { variables: [] } },
  ];

  for (const theme of ['dark', 'light'] as const) {
    test(`a ${theme} workspace with every kind of window has none`, async () => {
      await linked({
        theme,
        desktop: createDesktop(
          [
            createWorkspace(
              'Kinds',
              split(
                'column',
                0.5,
                split(
                  'row',
                  0.5,
                  split('row', 0.5, leaf('plot'), leaf('readouts')),
                  split('row', 0.5, leaf('editor'), leaf('maze'))
                ),
                split(
                  'row',
                  0.5,
                  split('row', 0.5, leaf('robot'), leaf('commands')),
                  split('row', 0.5, leaf('log'), leaf('link'))
                )
              )
            ),
          ],
          EVERY_KIND
        ),
      });
      await new Promise((resolve) => setTimeout(resolve, 1200));
      expect(await seriousViolations()).toEqual([]);
    });

    test(`every workspace of the package, ${theme}, has none`, async () => {
      const { store } = await linked({ theme });
      const count = store.getState().desktop.workspaces.length;
      const found: string[] = [];
      await Array.from({ length: count }).reduce<Promise<void>>(async (before, _, index) => {
        await before;
        store.getState().run({ type: 'switchWorkspace', index });
        await new Promise((resolve) => setTimeout(resolve, 600));
        found.push(...(await seriousViolations()).map((line) => `workspace ${index}: ${line}`));
      }, Promise.resolve());
      expect(found).toEqual([]);
    });
  }

  test('the notices have none', async () => {
    const { store } = await linked({
      updates: { waiting: () => true, subscribe: () => () => undefined, apply: () => undefined },
    });
    store.getState().savePreset('Bench');
    store.getState().deletePreset('Bench');
    await userEvent.keyboard(' ');
    await expect.poll(() => document.querySelector('[data-tone]')).not.toBeNull();
    expect(await seriousViolations()).toEqual([]);
  });
});
