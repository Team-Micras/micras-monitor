import { afterEach, describe, expect, test } from 'vitest';
import { userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-react';

import { RobotRegistry, type EnumType, type RobotPackage } from '@/core/robot';
import { mouse } from '@tests/support/core/robot/packages';
import { createDesktop, createWorkspace, leaf, split, type TileNode } from '@/tiling';

import { App } from '@/app/app';
import type { AppMonitor } from '@/app/monitor-context';
import { createShellStore, type ShellStore } from '@/app/state/shell-store';
import '@/app/styles.css';
import type { ShellWindow } from '@/app/windows/types';
import type { CommandOutcome, ReadOutcome } from '@/core/source';
import type { DemoRobot } from '@/sources/demo/demo-source';
import { settled } from '@tests/support/app/animations';
import { recordCommandOutcomes } from '@tests/support/app/command-outcomes';
import {
  DEMO_TARGET,
  demoMonitor,
  type DemoMonitorOptions,
} from '@tests/support/sources/demo-monitor';

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
    {
      code: 5,
      name: 'STOP',
      label: 'Stop',
      acceptedIn: 'any',
      pinned: true,
      key: 'Space',
      tone: 'danger',
    },
  ],
  refusalReasons: { 1: 'robot not idle' },
});

interface Options {
  readonly windows: readonly ShellWindow[];
  readonly root: TileNode;
  /** A second workspace, opened in the background. */
  readonly hidden?: TileNode;
  readonly robot?: Partial<DemoRobot>;
  readonly demo?: Pick<DemoMonitorOptions, 'answerMs' | 'drops' | 'stats'>;
  readonly send?: (code: number) => Promise<CommandOutcome>;
  readonly read?: (name: string) => Promise<ReadOutcome> | undefined;
}

interface Harness {
  readonly monitor: AppMonitor;
  readonly sent: number[];
  readonly readsOf: (name: string) => number;
  readonly store: ShellStore;
  readonly screen: Awaited<ReturnType<typeof render>>;
  /** Every text the Command outcome showed since the app came up. */
  readonly outcomes: () => string;
}

const monitors: AppMonitor[] = [];

afterEach(() => {
  monitors.splice(0).forEach((monitor) => monitor.disconnect());
});

function win(id: string, kind: string, variables: readonly string[] = []): ShellWindow {
  return { id, kind, payload: { variables } };
}

async function open({
  windows,
  root,
  hidden,
  robot,
  demo,
  send,
  read: customRead,
}: Options): Promise<Harness> {
  const sent: number[] = [];
  const reads: string[] = [];
  const monitor: AppMonitor = demoMonitor({
    sampleRateHz: 50,
    ...demo,
    robot,
    read: (variableId, inner) => {
      const name = monitor.state.variables[variableId]?.name ?? String(variableId);
      reads.push(name);
      return customRead?.(name) ?? inner.read(variableId);
    },
    command: (code, argument, inner) => {
      sent.push(code);
      return send?.(code) ?? inner.command(code, argument);
    },
  });
  monitors.push(monitor);
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
    <App monitor={monitor} robots={new RobotRegistry([PACKAGE])} store={store} synthetic />
  );
  const outcomes = recordCommandOutcomes(screen.getByRole('status', { name: 'Command outcome' }));
  monitor.connect(DEMO_TARGET);
  await expect.poll(() => monitor.state.status.kind).toBe('linked');
  const readsOf = (name: string) => reads.filter((read) => read === name).length;
  return { monitor, sent, readsOf, store, screen, outcomes };
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
      demo: { drops: (index) => index >= 10 && index < 25 },
    });
    await expect.poll(() => query('[data-plot]')?.dataset.empty, { timeout: 5000 }).toBe('false');
    await expect.element(screen.getByText('15 dropped')).toBeVisible();
    await expect.element(screen.getByText('m/s', { exact: true })).toBeVisible();
    await expect.element(screen.getByText('rad/s →')).toBeVisible();

    const live = canvasImage();
    await expect.poll(canvasImage).not.toBe(live);

    await screen.getByRole('button', { name: 'Pause Plot' }).click();
    await frames(2);
    const paused = canvasImage();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(canvasImage()).toBe(paused);

    await screen.getByRole('button', { name: 'Resume Plot' }).click();
    await expect.poll(canvasImage).not.toBe(paused);
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
    await expect.poll(time).not.toBe(first);
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
    const { monitor } = await open({
      windows: [win('values', 'readouts', ['battery_voltage', 'state'])],
      root: leaf('values'),
    });
    await expect.poll(batteryReadout).toMatch(/^battery_voltage12\.\d{3}V$/);
    const first = batteryReadout();
    await expect.poll(batteryReadout).not.toBe(first);
    await expect.poll(() => query('[data-readout="state"] dd')?.textContent).toMatch(/IDLE|INIT/);

    monitor.disconnect();
    await expect.poll(() => query('[data-readout="battery_voltage"]')?.dataset.stale).toBe('true');
  });
});

describe('Editor', () => {
  test('shows a write as pending until the robot confirms it, never as the confirmed value', async () => {
    const { screen } = await open({
      windows: [win('edit', 'editor', ['run_profile'])],
      root: leaf('edit'),
      demo: { answerMs: 400 },
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
            type: 'bool',
            access: { stream: false, write: true, writeNeedsIdle: false, persists: false },
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

  test('says when a read failed, and reads again on request', async () => {
    let failing = true;
    const { screen, readsOf } = await open({
      windows: [win('edit', 'editor', ['aux_flag'])],
      root: leaf('edit'),
      read: () =>
        failing ? Promise.resolve({ status: 'failed', message: 'the robot timed out' }) : undefined,
      robot: {
        variables: [
          {
            name: 'aux_flag',
            type: 'bool',
            access: { stream: false, write: true, writeNeedsIdle: false, persists: false },
            signal: () => 1,
          },
        ],
      },
    });
    await expect
      .element(screen.getByRole('alert'))
      .toHaveTextContent('Not read: the robot timed out');

    failing = false;
    await screen.getByRole('button', { name: 'Read again' }).click();
    await expect.poll(() => readsOf('aux_flag')).toBe(2);
    await expect.element(screen.getByRole('alert')).not.toBeInTheDocument();
    await expect.element(screen.getByRole('switch')).toBeEnabled();
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
          {
            name: 'gain',
            type: 'u8',
            access: { stream: true, write: true, writeNeedsIdle: false, persists: false },
            signal: () => 7,
          },
          {
            name: 'limit',
            type: 'f32',
            access: { stream: true, write: false, writeNeedsIdle: false, persists: false },
            signal: () => 1,
          },
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
          {
            name: 'speed',
            type: 'f32',
            access: { stream: true, write: true, writeNeedsIdle: false, persists: false },
            signal: () => 0.5,
          },
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
          {
            name: 'maze',
            type: 'bytes',
            access: { stream: false, write: false, writeNeedsIdle: false, persists: true },
            tag: 'maze-grid',
          },
          {
            name: 'maze/revision',
            type: 'u32',
            access: { stream: true, write: false, writeNeedsIdle: false, persists: false },
            signal: (seconds) => (seconds < 1.5 ? 1 : 2),
          },
        ],
      },
    });
    await expect.poll(() => query('[data-hex-dump]')?.textContent ?? '').toContain('0000');
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(readsOf('maze')).toBe(1);

    await expect.poll(() => readsOf('maze')).toBe(2);
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(readsOf('maze')).toBe(2);
  });
});

describe('A variable missing from the schema', () => {
  test('shows as missing in readouts, plots, editors and type views, and the others still work', async () => {
    const { screen } = await open({
      windows: [
        win('numbers', 'readouts', ['battery_voltage', 'ghost']),
        win('plot', 'plot', ['battery_voltage', 'ghost']),
        win('edit', 'editor', ['ghost']),
        win('blob', 'type-view', ['ghost']),
      ],
      root: split(
        'row',
        0.5,
        split('column', 0.5, leaf('numbers'), leaf('plot')),
        split('column', 0.5, leaf('edit'), leaf('blob'))
      ),
    });
    await expect.element(screen.getByText('missing', { exact: true })).toBeVisible();
    expect(query('[data-readout="ghost"]')?.dataset.missing).toBe('true');
    expect(query('[data-readout="battery_voltage"]')?.dataset.missing).toBe('false');
    await expect
      .poll(() => query('[data-readout="battery_voltage"] dd')?.textContent)
      .toMatch(/12/);
    await expect.element(screen.getByText('1 missing')).toBeVisible();
    await expect
      .element(screen.getByText('Missing: the schema of this robot has no such variable.'))
      .toBeVisible();
    await expect.element(screen.getByText('· missing from the schema')).toBeVisible();
    await expect.element(screen.getByRole('button', { name: 'Read ghost again' })).toBeDisabled();
  });

  test('is not called missing before any schema is loaded', async () => {
    const monitor = demoMonitor();
    const store = createShellStore({
      theme: 'dark',
      desktop: createDesktop(
        [createWorkspace('Test', leaf('numbers'))],
        [win('numbers', 'readouts', ['battery_voltage'])]
      ),
    });
    const screen = await render(
      <App monitor={monitor} robots={new RobotRegistry([PACKAGE])} store={store} synthetic />
    );
    await expect.element(screen.getByRole('term')).toHaveTextContent('battery_voltage');
    expect(query('[data-readout]')?.dataset.missing).toBe('false');
  });
});

describe('Commands', () => {
  test('warns, when their workspace closes with them, of commands still waiting', async () => {
    const answers: ((outcome: CommandOutcome) => void)[] = [];
    const { screen, store } = await open({
      windows: [win('commands', 'commands'), win('log', 'log')],
      root: leaf('commands'),
      hidden: leaf('log'),
      send: () => new Promise((resolve) => answers.push(resolve)),
    });
    await screen.getByRole('button', { name: 'Explore' }).click();
    await expect.poll(() => store.getState().waitingCommands.get('commands')).toBe(1);
    store.getState().requestCloseWorkspace(0, 'close');
    const dialog = screen.getByRole('dialog', { name: 'Close Test?' });
    await expect
      .element(dialog.getByRole('note'))
      .toHaveTextContent('1 command is still waiting for the robot.');
    await dialog.getByRole('radio', { name: 'Move them to Hidden' }).click();
    await expect.element(dialog.getByRole('note')).not.toBeInTheDocument();
    await dialog.getByRole('radio', { name: 'Close them with it' }).click();
    answers[0]?.({ status: 'ok', reason: null });
    await expect.poll(() => store.getState().waitingCommands.size).toBe(0);
    await expect.element(dialog.getByRole('note')).not.toBeInTheDocument();
  });

  test('asks before a dangerous command and shows the refusal with its reason', async () => {
    const { screen, sent, outcomes } = await open({
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
    await expect.element(screen.getByRole('dialog')).not.toBeInTheDocument();
    expect(sent).toEqual([]);

    await save.click();
    await expect.element(screen.getByRole('dialog')).toBeVisible();
    await settled();
    await screen.getByRole('dialog').getByRole('button', { name: 'Save' }).click();
    await expect
      .element(screen.getByText('Refused — robot not idle', { exact: true }))
      .toBeVisible();
    expect(sent).toEqual([3]);

    await screen.getByRole('main').getByRole('button', { name: 'Stop' }).click();
    expect(sent).toEqual([3, 5]);
    await expect.poll(outcomes).toContain('Stop refused');
  });

  test('sends STOP through the shell, again while a STOP still waits for its answer', async () => {
    const { screen, sent, outcomes } = await open({
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
    await expect.poll(outcomes).toContain('Stop');
  });

  test('hides the buttons without a robot', async () => {
    const { screen, monitor } = await open({
      windows: [win('commands', 'commands')],
      root: leaf('commands'),
    });
    await expect.element(screen.getByRole('button', { name: 'Explore' })).toBeEnabled();
    monitor.disconnect();
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
      demo: {
        stats: (stats) => ({
          ...stats,
          gauges: [{ label: 'Budget', used: 500, capacity: 500, unit: 'B/s', warn: true }],
          streams: stats.streams.map((stream) => ({ ...stream, grantedHz: stream.askedHz / 2 })),
        }),
      },
    });
    await expect.poll(() => query('[data-robot-state]')?.textContent).toMatch(/INIT|IDLE/);
    await expect.poll(() => query('[data-battery]')?.textContent).toMatch(/^Battery12\.\d{2}V$/);
    await expect.element(screen.getByText('micras answered with 78 variables')).toBeVisible();
    await screen.getByRole('button', { name: 'Warnings' }).click();
    await expect
      .element(screen.getByText('micras answered with 78 variables'))
      .not.toBeInTheDocument();
    await expect
      .element(screen.getByRole('alert'))
      .toHaveTextContent('The windows ask for more than the link carries');
    await expect.poll(() => query('[data-hex-dump]')?.textContent ?? '').toContain('0000');
  });
});
