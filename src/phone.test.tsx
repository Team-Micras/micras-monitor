import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-react';

import { App } from '@/app/app';
import { DEMO_VARIABLES, createDemoRobot } from '@/app/fake/demo-robot';
import type { FakeRobot } from '@/app/fake/fake-robot';
import type { MonitorPorts } from '@/app/ports';
import { createShellStore } from '@/app/state/shell-store';
import '@/app/styles.css';
import { RobotRegistry } from '@/robot-kit';
import type { AppUpdates } from '@/app/pwa/app-updates';

import { micras } from '@robots/micras';

const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1440, height: 900 };
const STOP_CODE = 5;
const IDLE = 1;
const RUN = 3;

const robots: FakeRobot[] = [];

beforeEach(async () => {
  await page.viewport(PHONE.width, PHONE.height);
});

afterEach(async () => {
  robots.splice(0).forEach((robot) => robot.disconnect());
  await page.viewport(DESKTOP.width, DESKTOP.height);
});

interface Options {
  readonly registry?: RobotRegistry<React.ReactNode>;
  readonly state?: number;
  readonly updates?: AppUpdates;
}

async function open(options: Options = {}) {
  const sent: number[] = [];
  const state = options.state;
  const [first, ...others] = DEMO_VARIABLES;
  const robot = createDemoRobot({
    connectMs: 5,
    handshakeMs: 10,
    configureMs: 5,
    commandMs: 5,
    tickMs: 20,
    ...(state === undefined
      ? {}
      : {
          variables: [{ ...first, signal: () => state }, ...others],
        }),
  });
  robots.push(robot);
  const ports: MonitorPorts = {
    ...robot.ports,
    commands: {
      send: (code, argument) => {
        sent.push(code);
        return robot.ports.commands.send(code, argument);
      },
    },
  };
  const screen = await render(
    <App
      ports={ports}
      robots={options.registry ?? new RobotRegistry([micras])}
      store={createShellStore({ theme: 'dark' })}
      updates={options.updates}
      synthetic
    />
  );
  robot.connect({ transport: 'websocket', url: 'ws://robot' });
  return { screen, sent, robot };
}

function rect(selector: string): DOMRect {
  const found = document.querySelector(selector);

  if (found === null) {
    throw new Error(`nothing matches ${selector}`);
  }

  return found.getBoundingClientRect();
}

describe('the phone view', () => {
  test('draws one column with the status, the maze, the values, the commands, a plot and the run profile', async () => {
    const { screen } = await open({ state: IDLE });

    await expect.element(screen.getByRole('region', { name: 'Status' })).toBeVisible();
    await expect.element(screen.getByText('IDLE')).toBeVisible();
    await expect.poll(() => document.querySelector('[data-battery]')?.textContent).toMatch(/^12\./);
    await expect
      .poll(() => document.querySelector('[data-maze]') !== null, { timeout: 10_000 })
      .toBe(true);
    await expect.element(screen.getByRole('region', { name: 'Values' })).toBeVisible();
    await expect
      .element(screen.getByRole('button', { name: 'Explore', exact: true }))
      .toBeVisible();
    await expect.element(screen.getByRole('region', { name: 'Plot' })).toBeInTheDocument();
    await expect.element(screen.getByRole('region', { name: 'Run profile' })).toBeInTheDocument();
    expect(document.querySelector('[data-tiling]')).toBeNull();
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(PHONE.width);
  });

  test('keeps STOP inside the screen, with a touch-sized target, and sends it', async () => {
    const { screen, sent } = await open({ state: RUN });
    const stop = screen.getByRole('button', { name: 'Stop', exact: true });
    await expect.element(stop).toBeEnabled();

    const box = rect('[data-phone] footer button');
    expect(box.bottom).toBeLessThanOrEqual(PHONE.height);
    expect(box.height).toBeGreaterThanOrEqual(48);
    expect(box.width).toBeGreaterThan(PHONE.width * 0.8);

    await stop.click();
    await expect.poll(() => sent).toEqual([STOP_CODE]);
    await expect.element(screen.getByRole('status', { name: 'Stop outcome' })).toBeVisible();
  });

  test('keeps STOP in reach after scrolling the overflowing column to its end', async () => {
    const { screen } = await open({ state: IDLE });
    await expect
      .element(screen.getByRole('button', { name: 'Explore', exact: true }))
      .toBeVisible();
    const column = document.querySelector('[data-phone] main');

    if (!(column instanceof HTMLElement)) {
      throw new Error('the phone has no column');
    }

    await expect.poll(() => column.scrollHeight - column.clientHeight).toBeGreaterThan(200);
    column.scrollTo({ top: column.scrollHeight });
    await expect.poll(() => column.scrollTop).toBeGreaterThan(200);

    const stop = document.querySelector('[data-phone] footer button');
    const box = rect('[data-phone] footer button');
    expect(box.bottom).toBeLessThanOrEqual(PHONE.height);
    expect(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)).toBe(stop);
  });

  test('gives the theme toggle a touch-sized target', async () => {
    const { screen } = await open({ state: IDLE });
    await expect
      .element(screen.getByRole('button', { name: 'Use the light theme' }))
      .toBeInTheDocument();

    const box = rect('[data-phone] main button[aria-label^="Use the"]');
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);
  });

  test('sends a command from the phone', async () => {
    const { screen, sent } = await open({ state: IDLE });

    await screen.getByRole('button', { name: 'Explore', exact: true }).click();

    await expect.poll(() => sent).toEqual([0]);
  });

  test('gives a robot with no package a plain view whose STOP is off', async () => {
    const { screen } = await open({ registry: new RobotRegistry([]) });

    await expect.element(screen.getByRole('region', { name: 'Status' })).toBeVisible();
    await expect.element(screen.getByRole('button', { name: 'Stop', exact: true })).toBeDisabled();
    await expect.element(screen.getByRole('region', { name: 'Maze' })).not.toBeInTheDocument();
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(PHONE.width);
  });

  test('is replaced by the tiling on a wide screen', async () => {
    await page.viewport(DESKTOP.width, DESKTOP.height);
    const { screen } = await open();

    await expect.element(screen.getByRole('region', { name: 'Workspace Overview' })).toBeVisible();
    expect(document.querySelector('[data-phone]')).toBeNull();
  });
});

function waitingUpdate() {
  const apply = vi.fn<() => void>();
  const updates: AppUpdates = { waiting: () => true, subscribe: () => () => undefined, apply };
  return { updates, apply };
}

describe('the update notice on the phone', () => {
  test('refuses to reload while the robot runs', async () => {
    const { updates, apply } = waitingUpdate();
    const { screen } = await open({ state: RUN, updates });

    await expect.element(screen.getByRole('status', { name: 'Update available' })).toBeVisible();
    await expect.element(screen.getByRole('button', { name: 'Reload' })).toBeDisabled();
    expect(apply).not.toHaveBeenCalled();
  });

  test('reloads once the robot is idle, and only when asked', async () => {
    const { updates, apply } = waitingUpdate();
    const { screen } = await open({ state: IDLE, updates });

    const reload = screen.getByRole('button', { name: 'Reload' });
    await expect.element(reload).toBeEnabled();
    expect(apply).not.toHaveBeenCalled();

    await reload.click();
    expect(apply).toHaveBeenCalledTimes(1);
  });

  test('never covers the STOP outcome', async () => {
    const { updates } = waitingUpdate();
    const { screen } = await open({ state: RUN, updates });
    await screen.getByRole('button', { name: 'Stop', exact: true }).click();
    await expect.element(screen.getByRole('status', { name: 'Stop outcome' })).toBeVisible();

    const notice = rect('output[aria-label="Update available"]');
    const outcome = rect('output[aria-label="Stop outcome"] p');
    const overlap =
      notice.left < outcome.right &&
      outcome.left < notice.right &&
      notice.top < outcome.bottom &&
      outcome.top < notice.bottom;

    expect(overlap).toBe(false);
    expect(notice.bottom).toBeLessThan(rect('[data-phone] footer').top);
  });
});
