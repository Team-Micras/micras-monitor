import { createElement, type ReactNode } from 'react';
import { describe, expect, test, vi } from 'vitest';
import { userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-react';

import { RobotRegistry } from '@/robot-kit';
import { mouse } from '@/robot-kit/fixtures/packages';

import { App } from './app';
import { createDemoRobot } from './fake/demo-robot';
import type { MonitorPorts } from './ports';
import './styles.css';
import { createShellStore } from './state/shell-store';
import type { WindowViewProps } from './windows/types';

const chunk = vi.hoisted(() => ({ broken: true, attempts: 0 }));

vi.mock('./windows/plot/plot-window', async (importOriginal) => {
  const original = await importOriginal<typeof import('./windows/plot/plot-window')>();

  return {
    PlotWindow: (props: WindowViewProps) => {
      chunk.attempts += 1;

      if (chunk.broken) {
        throw new Error('Failed to fetch dynamically imported module');
      }

      return createElement(original.PlotWindow, props);
    },
  };
});

const STOP = 5;

async function mount() {
  const robot = createDemoRobot({ connectMs: 5, handshakeMs: 10, configureMs: 5, commandMs: 5 });
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
  const screen = await render(
    <App
      ports={ports}
      robots={new RobotRegistry<ReactNode>([mouse({ id: 'micras', displayName: 'Micras' })])}
      store={createShellStore({ theme: 'dark' })}
      synthetic
    />
  );
  await screen.getByRole('button', { name: 'Connect', exact: true }).click();
  await screen.getByRole('dialog').getByRole('button', { name: 'Connect' }).click();
  await expect.element(screen.getByText('· connected')).toBeVisible();
  await userEvent.keyboard('{Escape}');
  await expect.element(screen.getByRole('dialog')).not.toBeInTheDocument();
  return { screen, sent };
}

describe('a window that fails to load', () => {
  test('leaves the app and every STOP working, and loads on retry once the chunk works', async () => {
    const { screen, sent } = await mount();

    const failures = screen.getByRole('region', { name: 'Window failed to load' });
    await expect.element(failures.first()).toBeVisible();
    await expect.element(screen.getByRole('region', { name: 'Workspace Overview' })).toBeVisible();
    expect(chunk.attempts).toBeGreaterThan(0);

    await screen.getByRole('banner').getByRole('button', { name: /^Stop/ }).click();
    await userEvent.keyboard(' ');
    await screen.getByRole('main').getByRole('button', { name: 'Stop' }).click();
    expect(sent).toEqual([STOP, STOP, STOP]);

    const before = chunk.attempts;
    chunk.broken = false;
    await failures.first().getByRole('button', { name: 'Retry' }).click();
    await expect.poll(() => document.querySelector('[data-plot]')).not.toBeNull();
    await expect.element(failures.first()).not.toBeInTheDocument();
    expect(chunk.attempts).toBeGreaterThan(before);
  });
});
