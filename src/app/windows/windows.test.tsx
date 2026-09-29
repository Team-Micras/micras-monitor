import { afterEach, describe, expect, test } from 'vitest';
import { userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-react';

import { TypeCode, decodeAccess } from '@/protocol';
import { RobotRegistry, type EnumType, type RobotPackage } from '@/robot-kit';
import { mouse } from '@/robot-kit/fixtures/packages';
import { createDesktop, createWorkspace, leaf, split, type TileNode } from '@/tiling';

import { App } from '../app';
import { createDemoRobot } from '../fake/demo-robot';
import type { FakeRobot, FakeRobotOptions } from '../fake/fake-robot';
import type { CommandOutcome, MonitorPorts } from '../ports';
import { createShellStore, type ShellStore } from '../state/shell-store';
import '../styles.css';
import type { ShellWindow } from './types';

const STATE: EnumType = {
  kind: 'enum',
  name: 'State',
  options: ['INIT', 'IDLE', 'WAIT_FOR_RUN', 'RUN'].map((label, value) => ({ value, label })),
};

const PACKAGE: RobotPackage<string> = mouse({
  id: 'micras',
  displayName: 'Micras',
  roles: {
    state: 'state',
    battery: 'battery_voltage',
    map: 'maze',
    'map.revision': 'maze/revision',
  },
  variables: {
    state: { labels: STATE },
    battery_voltage: { unit: 'V' },
    'pose/linear_speed': { unit: 'm/s' },
    'pose/angular_speed': { unit: 'rad/s' },
    objective: {
      labels: {
        kind: 'enum',
        name: 'Objective',
        options: [
          { value: 0, label: 'EXPLORE' },
          { value: 1, label: 'RETURN' },
        ],
      },
    },
    run_profile: {
      labels: {
        kind: 'bitmask',
        name: 'RunProfile',
        flags: [
          { bit: 0, label: 'FAN' },
          { bit: 1, label: 'RACING_LINE' },
          { bit: 2, label: 'BOOST' },
        ],
      },
    },
  },
  commands: [
    { code: 0, name: 'EXPLORE', label: 'Explore', acceptedIn: [1] },
    {
      code: 3,
      name: 'SAVE',
      label: 'Save',
      confirm: 'Save the maze to the flash?',
      acceptedIn: [1],
    },
    { code: 5, name: 'STOP', label: 'Stop', acceptedIn: 'any', emergency: true },
  ],
  refusalReasons: { 1: 'robot not idle' },
});

interface Options {
  readonly windows: readonly ShellWindow[];
  readonly root: TileNode;
  /** A second workspace, opened in the background. */
  readonly hidden?: TileNode;
  readonly robot?: Partial<FakeRobotOptions>;
  readonly send?: (code: number) => Promise<CommandOutcome>;
}

interface Harness {
  readonly robot: FakeRobot;
  readonly sent: number[];
  readonly readsOf: (name: string) => number;
  readonly store: ShellStore;
  readonly screen: Awaited<ReturnType<typeof render>>;
}

const robots: FakeRobot[] = [];

afterEach(() => {
  robots.splice(0).forEach((robot) => robot.disconnect());
});

function win(id: string, kind: string, variables: readonly string[] = []): ShellWindow {
  return { id, kind, payload: { variables } };
}

async function open({ windows, root, hidden, robot: overrides, send }: Options): Promise<Harness> {
  const robot = createDemoRobot({
    connectMs: 5,
    handshakeMs: 10,
    configureMs: 5,
    commandMs: 5,
    tickMs: 20,
    ...overrides,
  });
  robots.push(robot);
  const sent: number[] = [];
  const reads: string[] = [];
  const ports: MonitorPorts = {
    ...robot.ports,
    reads: {
      read: (name) => {
        reads.push(name);
        return robot.ports.reads.read(name);
      },
    },
    commands: {
      send: (code, argument) => {
        sent.push(code);
        return send?.(code) ?? robot.ports.commands.send(code, argument);
      },
    },
  };
  const store = createShellStore({
    theme: 'dark',
    desktop: createDesktop(
      hidden === undefined
        ? [createWorkspace('Test', root)]
        : [createWorkspace('Test', root), createWorkspace('Hidden', hidden)],
      windows
    ),
  });
  const screen = await render(
    <App ports={ports} robots={new RobotRegistry([PACKAGE])} store={store} synthetic />
  );
  robot.connect({ transport: 'websocket', url: 'ws://robot' });
  await expect.poll(() => robot.ports.connection.status()).toMatchObject({ phase: 'streaming' });
  const readsOf = (name: string) => reads.filter((read) => read === name).length;
  return { robot, sent, readsOf, store, screen };
}

function query(selector: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(selector);
}

function canvasImage(): string {
  return document.querySelector<HTMLCanvasElement>('[data-plot] canvas')?.toDataURL() ?? '';
}

function frames(count: number): Promise<void> {
  return new Promise((resolve) => {
    const step = (left: number) => {
      if (left === 0) {
        resolve();
      } else {
        requestAnimationFrame(() => step(left - 1));
      }
    };
    step(count);
  });
}

function batteryReadout(): string {
  return query('[data-readout="battery_voltage"]')?.textContent ?? '';
}

describe('Plot', () => {
  test('draws from the store, marks dropped samples and freezes while paused', async () => {
    const { screen } = await open({
      windows: [win('plot', 'plot', ['pose/linear_speed', 'pose/angular_speed'])],
      root: leaf('plot'),
      robot: { drops: (sequence) => sequence >= 10 && sequence < 25 },
    });
    await expect.poll(() => query('[data-plot]')?.dataset.empty).toBe('false');
    await expect.element(screen.getByText('15 dropped')).toBeVisible();
    await expect.element(screen.getByText('m/s', { exact: true })).toBeVisible();
    await expect.element(screen.getByText('rad/s →')).toBeVisible();

    const live = canvasImage();
    await expect.poll(canvasImage, { timeout: 2000 }).not.toBe(live);

    await screen.getByRole('button', { name: 'Pause Plot' }).click();
    await frames(2);
    const paused = canvasImage();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(canvasImage()).toBe(paused);

    await screen.getByRole('button', { name: 'Resume Plot' }).click();
    await expect.poll(canvasImage, { timeout: 2000 }).not.toBe(paused);
  });

  test('keeps its frozen window across a change of theme', async () => {
    const { screen, store } = await open({
      windows: [win('plot', 'plot', ['pose/linear_speed'])],
      root: leaf('plot'),
    });
    await expect.poll(() => query('[data-plot]')?.dataset.empty).toBe('false');
    await screen.getByRole('button', { name: 'Pause Plot' }).click();
    await frames(2);
    const redraw = async () => {
      const dark = canvasImage();
      store.getState().setTheme('light');
      await expect.poll(canvasImage).not.toBe(dark);
      const light = canvasImage();
      store.getState().setTheme('dark');
      await expect.poll(canvasImage).not.toBe(light);
      return canvasImage();
    };
    const paused = await redraw();
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(await redraw()).toBe(paused);
  });

  test('keeps the tooltip on the moment under the cursor while the plot scrolls', async () => {
    await open({
      windows: [win('plot', 'plot', ['pose/linear_speed'])],
      root: leaf('plot'),
    });
    await expect.poll(() => query('[data-plot]')?.dataset.empty).toBe('false');
    const over = query('[data-plot] .u-over');
    const box = over?.getBoundingClientRect();
    over?.dispatchEvent(new PointerEvent('pointerenter'));
    over?.dispatchEvent(
      new MouseEvent('mousemove', {
        bubbles: true,
        clientX: (box?.x ?? 0) + (box?.width ?? 0) * 0.98,
        clientY: (box?.y ?? 0) + (box?.height ?? 0) / 2,
      })
    );
    const time = () => query('[data-plot-tooltip] div')?.textContent ?? '';
    await expect.poll(time).toMatch(/^t \d\d:\d\d\.\d$/);
    const first = time();
    await expect.poll(time, { timeout: 2000 }).not.toBe(first);
  });

  test('does not draw on a hidden workspace, and draws once shown', async () => {
    const { store } = await open({
      windows: [win('values', 'readouts', ['state']), win('plot', 'plot', ['pose/linear_speed'])],
      root: leaf('values'),
      hidden: leaf('plot'),
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    const hidden = canvasImage();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(canvasImage()).toBe(hidden);

    store.getState().run({ type: 'switchWorkspace', index: 1 });
    await expect.poll(() => query('[data-plot]')?.dataset.empty).toBe('false');
    await expect.poll(canvasImage).not.toBe(hidden);
  });

  test('changes the length of its live window', async () => {
    const { screen } = await open({
      windows: [win('plot', 'plot', ['pose/linear_speed'])],
      root: leaf('plot'),
    });
    await screen.getByRole('button', { name: 'Window length' }).click();
    await screen.getByRole('menuitemradio', { name: '2 s' }).click();
    await expect
      .element(screen.getByRole('button', { name: 'Window length' }))
      .toHaveTextContent('2 s');
  });
});

describe('Readouts', () => {
  test('update with the values, with units and labels, and go stale without a link', async () => {
    const { robot } = await open({
      windows: [win('values', 'readouts', ['battery_voltage', 'state'])],
      root: leaf('values'),
    });
    await expect.poll(batteryReadout).toMatch(/^battery_voltage12\.\d{3}V$/);
    const first = batteryReadout();
    await expect.poll(batteryReadout, { timeout: 2000 }).not.toBe(first);
    await expect.poll(() => query('[data-readout="state"] dd')?.textContent).toMatch(/IDLE|INIT/);

    robot.disconnect();
    await expect.poll(() => query('[data-readout="battery_voltage"]')?.dataset.stale).toBe('true');
  });
});

describe('Editor', () => {
  test('shows a write as pending until the robot confirms it, never as the confirmed value', async () => {
    const { screen } = await open({
      windows: [win('edit', 'editor', ['run_profile'])],
      root: leaf('edit'),
      robot: { commandMs: 400 },
    });
    const racing = screen.getByRole('switch').nth(1);
    await expect.element(racing).toHaveAttribute('data-state', 'unchecked');
    await racing.click();

    await expect.element(screen.getByText('pending ack')).toBeVisible();
    await expect.element(screen.getByText('sent, waiting for the robot to confirm')).toBeVisible();
    await expect.element(racing).toHaveAttribute('data-state', 'unchecked');
    expect(query('[data-confirmed]')?.textContent).toBe('FAN · BOOST');

    await expect.element(racing).toHaveAttribute('data-state', 'checked');
    await expect.element(screen.getByText('confirmed by the robot')).toBeVisible();
    await expect
      .poll(() => query('[data-confirmed]')?.textContent)
      .toBe('FAN · RACING_LINE · BOOST');
  });

  test('reads a writable variable that does not stream, on link-up and after a write', async () => {
    const { screen, readsOf } = await open({
      windows: [win('edit', 'editor', ['aux_flag'])],
      root: leaf('edit'),
      robot: {
        variables: [
          {
            name: 'aux_flag',
            type: TypeCode.BOOL,
            access: decodeAccess(0x02),
            signal: () => 1,
          },
        ],
      },
    });
    const flag = screen.getByRole('switch');
    await expect.element(flag).toHaveAttribute('data-state', 'checked');
    await expect.element(flag).toBeEnabled();
    expect(readsOf('aux_flag')).toBe(1);

    await flag.click();
    await expect.poll(() => readsOf('aux_flag')).toBe(2);
  });

  test('says why the robot refused a write and keeps the confirmed value', async () => {
    const { screen } = await open({
      windows: [win('edit', 'editor', ['objective'])],
      root: leaf('edit'),
      robot: { answerWrite: () => ({ status: 'refused', reason: 'needs-idle' }) },
    });
    await screen.getByRole('button', { name: 'RETURN' }).click();
    await expect
      .element(screen.getByRole('alert'))
      .toHaveTextContent('Refused: the robot takes it only while idle');
    await expect
      .element(screen.getByRole('button', { name: 'EXPLORE' }))
      .toHaveAttribute('aria-pressed', 'true');
    await expect
      .element(screen.getByRole('button', { name: 'RETURN' }))
      .toHaveAttribute('aria-pressed', 'false');
  });

  test('checks typed numbers against the type before writing', async () => {
    const { screen } = await open({
      windows: [win('edit', 'editor', ['gain', 'limit'])],
      root: leaf('edit'),
      robot: {
        variables: [
          { name: 'gain', type: TypeCode.U8, access: decodeAccess(0x03), signal: () => 7 },
          { name: 'limit', type: TypeCode.F32, access: decodeAccess(0x01), signal: () => 1 },
        ],
      },
    });
    const field = screen.getByRole('textbox', { name: 'New value' }).first();
    await field.fill('300');
    await userEvent.keyboard('{Enter}');
    await expect.element(screen.getByRole('alert')).toHaveTextContent('Enter 0 to 255');

    await field.fill('42');
    await userEvent.keyboard('{Enter}');
    await expect.poll(() => query('[data-editor="gain"] [data-confirmed]')?.textContent).toBe('42');
    await expect.element(screen.getByRole('textbox', { name: 'New value' }).nth(1)).toBeDisabled();
    await expect
      .element(screen.getByText('The robot does not take writes of this variable.'))
      .toBeVisible();
  });
});

describe('Editor of a float', () => {
  test('says the robot confirmed a value an f32 cannot hold exactly', async () => {
    const { screen } = await open({
      windows: [win('edit', 'editor', ['speed'])],
      root: leaf('edit'),
      robot: {
        variables: [
          { name: 'speed', type: TypeCode.F32, access: decodeAccess(0x03), signal: () => 0.5 },
        ],
      },
    });
    await screen.getByRole('textbox', { name: 'New value' }).fill('0.1');
    await userEvent.keyboard('{Enter}');
    await expect.element(screen.getByText('confirmed by the robot')).toBeVisible();
  });
});

describe('Type view', () => {
  test('reads the blob again only when the value of its revision changes', async () => {
    const { readsOf } = await open({
      windows: [win('maze', 'type-view', ['maze'])],
      root: leaf('maze'),
      robot: {
        variables: [
          { name: 'maze', type: TypeCode.BLOB, access: decodeAccess(0x08), typeTag: 'maze-grid' },
          {
            name: 'maze/revision',
            type: TypeCode.U32,
            access: decodeAccess(0x01),
            signal: (seconds) => (seconds < 1.5 ? 1 : 2),
          },
        ],
      },
    });
    await expect.poll(() => query('[data-hex-dump]')?.textContent ?? '').toContain('0000');
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(readsOf('maze')).toBe(1);

    await expect.poll(() => readsOf('maze'), { timeout: 2000 }).toBe(2);
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(readsOf('maze')).toBe(2);
  });
});

describe('Commands', () => {
  test('asks before a dangerous command and shows the refusal with its reason', async () => {
    const { screen, sent } = await open({
      windows: [win('commands', 'commands')],
      root: leaf('commands'),
      send: () => Promise.resolve({ status: 'refused', reason: 1 }),
    });
    const save = screen.getByRole('button', { name: 'Save' });
    await save.click();
    await expect
      .element(screen.getByRole('dialog'))
      .toHaveTextContent('Save the maze to the flash?');
    await screen.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
    expect(sent).toEqual([]);

    await save.click();
    await screen.getByRole('dialog').getByRole('button', { name: 'Save' }).click();
    await expect.element(screen.getByRole('alert')).toHaveTextContent('Refused — robot not idle');
    expect(sent).toEqual([3]);

    await screen.getByRole('main').getByRole('button', { name: 'Stop' }).click();
    expect(sent).toEqual([3, 5]);
    await expect
      .element(screen.getByRole('status', { name: 'Stop outcome' }))
      .toHaveTextContent('Stop refused');
  });

  test('sends STOP through the shell, again while a STOP still waits for its answer', async () => {
    const { screen, sent } = await open({
      windows: [win('commands', 'commands')],
      root: leaf('commands'),
      send: (code) =>
        code === 5 ? new Promise(() => undefined) : Promise.resolve({ status: 'ok', reason: 0 }),
    });
    const stop = screen.getByRole('main').getByRole('button', { name: 'Stop' });
    await stop.click();
    await expect.element(stop).toBeEnabled();
    await stop.click();
    expect(sent).toEqual([5, 5]);
    await expect
      .element(screen.getByRole('status', { name: 'Stop outcome' }))
      .toHaveTextContent('Stop');
  });

  test('keeps the buttons through a reconfiguration and hides them without a robot', async () => {
    const { screen, robot } = await open({
      windows: [win('commands', 'commands')],
      root: leaf('commands'),
    });
    await expect.element(screen.getByRole('button', { name: 'Explore' })).toBeEnabled();
    robot.reconfigure();
    await expect.element(screen.getByRole('button', { name: 'Explore' })).toBeEnabled();
    robot.disconnect();
    await expect.element(screen.getByText('Connect to a robot to send its commands')).toBeVisible();
    await expect.element(screen.getByRole('button', { name: 'Explore' })).not.toBeInTheDocument();
  });
});

describe('Robot, Log, Link and Type view', () => {
  test('show the state by role, the log, the budget and a raw blob', async () => {
    const { screen } = await open({
      windows: [
        win('robot', 'robot'),
        win('log', 'log'),
        win('link', 'link'),
        win('maze', 'type-view', ['maze']),
      ],
      root: split(
        'row',
        0.5,
        split('column', 0.5, leaf('robot'), leaf('log')),
        split('column', 0.5, leaf('link'), leaf('maze'))
      ),
      robot: { budgetBytesPerSecond: 500 },
    });
    await expect.poll(() => query('[data-robot-state]')?.textContent).toMatch(/INIT|IDLE/);
    await expect.poll(() => query('[data-battery]')?.textContent).toMatch(/^Battery12\.\d{2}V$/);
    await expect.element(screen.getByText('schema loaded, 78 variables')).toBeVisible();
    await screen.getByRole('button', { name: 'Warnings' }).click();
    await expect.element(screen.getByText('schema loaded, 78 variables')).not.toBeInTheDocument();
    await expect
      .element(screen.getByRole('alert'))
      .toHaveTextContent('The windows ask for more than the link carries');
    await expect.poll(() => query('[data-hex-dump]')?.textContent ?? '').toContain('0000');
  });
});
