import { afterEach, describe, expect, test } from 'vitest';
import { userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-react';

import { RobotRegistry } from '@/robot-kit';
import { mouse } from '@tests/support/robot-kit/packages';
import { activeWorkspace, focusedWindow } from '@/tiling';

import { App } from '@/app/app';
import type { AppUpdates } from '@/app/pwa/app-updates';
import '@/app/styles.css';
import { createShellStore, type ShellStore } from '@/app/state/shell-store';
import { describeRobot } from '@/app/sessions/browser-sessions';
import { MemorySessionLibrary } from '@/app/sessions/memory-library';
import { MemoryLocks } from '@/app/sessions/session-library';
import { SessionManager } from '@/app/sessions/session-manager';
import { ManualScheduler } from '@/telemetry';
import { recordCommandOutcomes } from '@tests/support/app/command-outcomes';
import { demoMonitor, recordCommands } from '@tests/support/sources/demo-monitor';

const MICRAS = mouse({ id: 'micras', displayName: 'Micras' });
const PLOTTED = 'imu/gyro_z';
const STOP = 5;

let stop: (() => void) | undefined;

afterEach(() => {
  stop?.();
  stop = undefined;
});

async function setup(updates?: AppUpdates) {
  const sent: number[] = [];
  const monitor = demoMonitor({ command: recordCommands(sent) });
  const library = new MemorySessionLibrary();
  const sessions = new SessionManager({
    store: monitor.history,
    library,
    locks: new MemoryLocks(),
    scheduler: new ManualScheduler(),
    describe: () => describeRobot(monitor),
  });
  await sessions.start();
  const shell: ShellStore = createShellStore({ theme: 'dark' });
  const screen = await render(
    <App
      monitor={monitor}
      robots={new RobotRegistry([MICRAS])}
      store={shell}
      sessions={sessions}
      updates={updates}
      synthetic
    />
  );
  await expect.element(screen.getByRole('region', { name: 'Workspace Overview' })).toBeVisible();
  await screen.getByRole('button', { name: 'Connect', exact: true }).click();
  await screen.getByRole('dialog').getByRole('button', { name: 'Connect' }).click();
  await expect.element(screen.getByText('· connected')).toBeVisible();
  await userEvent.keyboard('{Escape}');
  stop = () => monitor.disconnect();
  return { monitor, sessions, shell, screen, library, sent };
}

function recButton(screen: Awaited<ReturnType<typeof render>>) {
  return screen.getByRole('button', { name: /^Recording, / });
}

describe('REC and the sessions', () => {
  test('records from the top bar, with the time and the size, and stops', async () => {
    const { sessions, screen } = await setup();
    await recButton(screen).click();
    await screen.getByRole('button', { name: 'Start recording' }).click();

    await expect.element(screen.getByRole('button', { name: 'Recording, on' })).toBeVisible();
    await expect
      .poll(() => sessions.state.recording?.stats.samples ?? 0, { timeout: 15_000 })
      .toBeGreaterThan(0);
    await recButton(screen).click();
    await expect.element(screen.getByRole('button', { name: 'Stop recording' })).toBeVisible();
    await expect.element(screen.getByText(/ in memory/)).toBeVisible();
    await screen.getByRole('button', { name: 'Stop recording' }).click();

    await expect.element(screen.getByRole('button', { name: 'Recording, off' })).toBeVisible();
    expect(sessions.state.sessions[0]).toMatchObject({ state: 'saved' });
  });

  test('opens a saved session read only in the windows, and goes back to live', async () => {
    const { sessions, shell, screen } = await setup();
    shell.getState().openWindow('plot', [PLOTTED]);
    await sessions.startRecording();
    await expect
      .poll(() => sessions.state.recording?.stats.samples ?? 0, { timeout: 15_000 })
      .toBeGreaterThan(0);
    await sessions.stopRecording();
    const [saved] = sessions.state.sessions;

    await recButton(screen).click();
    await screen.getByRole('button', { name: /Sessions/ }).click();
    const dialog = screen.getByRole('dialog', { name: 'Sessions' });
    await expect.element(dialog.getByText(saved.name)).toBeVisible();
    await expect
      .element(dialog.getByRole('button', { name: `Delete ${saved.name}` }))
      .toBeDisabled();
    await dialog.getByRole('button', { name: 'Open' }).click();

    await expect.element(screen.getByTitle(`Saved session ${saved.name}`)).toBeVisible();
    await expect.element(screen.getByRole('button', { name: /Stop/ }).first()).toBeEnabled();
    await screen.getByRole('button', { name: 'Live', exact: true }).click();
    await expect.element(screen.getByTitle(`Saved session ${saved.name}`)).not.toBeInTheDocument();
    expect(sessions.state.viewing).toBeNull();
  });

  test('sends a pinned command to the live robot while a saved session is on screen', async () => {
    const { sessions, screen, sent } = await setup();
    const outcomes = recordCommandOutcomes(screen.getByRole('status', { name: 'Command outcome' }));
    await sessions.startRecording();
    await expect
      .poll(() => sessions.state.recording?.stats.samples ?? 0, { timeout: 15_000 })
      .toBeGreaterThan(0);
    await sessions.stopRecording();
    await sessions.open(sessions.state.sessions[0].id);
    await expect.poll(() => sessions.state.viewing).not.toBeNull();

    await screen.getByRole('banner').getByRole('button', { name: /^Stop/ }).click();
    await userEvent.keyboard(' ');

    expect(sent).toEqual([STOP, STOP]);
    await expect.poll(outcomes).toContain('Stop accepted');
    await expect
      .element(screen.getByRole('main').getByRole('button', { name: 'Go' }).first())
      .toBeDisabled();
  });

  test('holds back an app update while recording, and lets it through once stopped', async () => {
    const { sessions, screen } = await setup({
      waiting: () => true,
      subscribe: () => () => undefined,
      apply: () => undefined,
    });
    await sessions.startRecording();
    const notice = screen.getByRole('status', { name: 'Update available' });

    await expect.element(notice).toHaveTextContent('Stop recording to reload');
    await expect.element(notice.getByRole('button', { name: 'Reload' })).toBeDisabled();
    await sessions.stopRecording();
    await expect.element(notice).not.toHaveTextContent('Stop recording to reload');
  });

  test('renames a session in the list', async () => {
    const { sessions, screen } = await setup();
    await sessions.startRecording();
    await sessions.stopRecording();
    const [saved] = sessions.state.sessions;
    await recButton(screen).click();
    await screen.getByRole('button', { name: /Sessions/ }).click();
    await screen.getByRole('button', { name: `Rename ${saved.name}` }).click();
    await userEvent.keyboard('{Control>}a{/Control}Final run{Enter}');

    await expect.element(screen.getByText('Final run')).toBeVisible();
    expect(sessions.state.sessions[0].name).toBe('Final run');
  });

  test('asks before resetting the live session', async () => {
    const { monitor, screen } = await setup();
    await expect
      .poll(() => monitor.history.timeRange() !== undefined, { timeout: 15_000 })
      .toBe(true);
    await recButton(screen).click();
    await screen.getByRole('button', { name: /Reset the live session/ }).click();
    await screen.getByRole('button', { name: 'Reset session' }).click();

    await expect.poll(() => monitor.history.generation).toBe(1);
  });
});

describe('scrolling a plot back in time', () => {
  test('zooms and pauses the window on a wheel, moves it by keys and drag, and follows live again', async () => {
    const { monitor, shell, screen } = await setup();
    shell.getState().openWindow('plot', [PLOTTED]);
    await expect
      .poll(() => monitor.history.timeRange(PLOTTED)?.endUs ?? 0, { timeout: 15_000 })
      .toBeGreaterThan(3e6);
    const plot = document.querySelector<HTMLElement>(
      `[data-window="${focusedId(shell)}"] [data-plot]`
    );

    if (plot === null) {
      throw new Error('No plot');
    }

    const over = plot.querySelector<HTMLElement>('.u-over');
    const box = over?.getBoundingClientRect();
    over?.dispatchEvent(
      new WheelEvent('wheel', {
        deltaY: -400,
        clientX: (box?.left ?? 0) + 50,
        clientY: (box?.top ?? 0) + 50,
        bubbles: true,
        cancelable: true,
      })
    );

    await expect.poll(() => shell.getState().paused.has(focusedId(shell))).toBe(true);
    const frozen = Number(plot.dataset.windowEndUs);
    await new Promise((resolve) => {
      setTimeout(resolve, 600);
    });
    expect(Number(plot.dataset.windowEndUs)).toBe(frozen);
    expect(Number(plot.dataset.windowEndUs) - Number(plot.dataset.windowStartUs)).toBeLessThan(5e6);

    plot.closest<HTMLElement>('[data-window]')?.focus();
    await userEvent.keyboard('{Home}');
    await expect
      .poll(() => Number(plot.dataset.windowStartUs))
      .toBe(monitor.history.timeRange(PLOTTED)!.startUs);
    await userEvent.keyboard('{+}{+}');
    const zoomed = Number(plot.dataset.windowStartUs);
    const left = (box?.left ?? 0) + 200;
    const at = { clientY: (box?.top ?? 0) + 60, pointerId: 7, bubbles: true, button: 0 };
    over?.dispatchEvent(new PointerEvent('pointerdown', { ...at, clientX: left }));
    over?.dispatchEvent(new PointerEvent('pointermove', { ...at, clientX: left - 120 }));
    over?.dispatchEvent(new PointerEvent('pointerup', { ...at, clientX: left - 120 }));
    await expect.poll(() => Number(plot.dataset.windowStartUs)).toBeGreaterThan(zoomed);
    await screen.getByRole('button', { name: 'Back to live' }).click();

    await expect.poll(() => shell.getState().paused.has(focusedId(shell))).toBe(false);
    await expect.poll(() => Number(plot.dataset.windowEndUs)).toBeGreaterThan(frozen);
  });
});

function focusedId(shell: ShellStore): string {
  const id = focusedWindow(activeWorkspace(shell.getState().desktop));

  if (id === null) {
    throw new Error('No window has the focus');
  }

  return id;
}
