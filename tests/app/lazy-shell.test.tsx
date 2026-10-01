import { createElement, type ReactNode } from 'react';
import { describe, expect, test, vi } from 'vitest';
import { userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-react';

import { RobotRegistry } from '@/robot-kit';
import { mouse } from '@tests/support/robot-kit/packages';

import { App } from '@/app/app';
import { createDemoRobot } from '@/app/fake/demo-robot';
import type { MonitorPorts } from '@/app/ports';
import '@/app/styles.css';
import { createShellStore } from '@/app/state/shell-store';

const chunks = vi.hoisted(() => {
  const gate: { resolve: () => void; promise: Promise<void> } = {
    resolve: () => undefined,
    promise: Promise.resolve(),
  };
  gate.promise = new Promise<void>((resolve) => {
    gate.resolve = resolve;
  });
  return gate;
});

vi.mock('@/app/shell/launcher', async (importOriginal) => {
  await chunks.promise;
  return importOriginal();
});

vi.mock('@/app/shell/variable-drawer', async (importOriginal) => {
  await chunks.promise;
  return importOriginal();
});

const STOP = 5;

describe('the shell before its lazy chunks arrive', () => {
  test('sends STOP on Space, and opens the launcher and the drawer once their chunks arrive', async () => {
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
    const store = createShellStore({ theme: 'dark' });
    const screen = await render(
      createElement(App, {
        ports,
        robots: new RobotRegistry<ReactNode>([mouse({ id: 'micras', displayName: 'Micras' })]),
        store,
        synthetic: true,
      })
    );
    robot.ports.connection.connect({ transport: 'websocket', url: 'ws://robot' });
    await expect.element(screen.getByText('· connected')).toBeVisible();

    await userEvent.keyboard(' ');
    expect(sent).toEqual([STOP]);

    await userEvent.keyboard('{Control>}k{/Control}');
    expect(store.getState().overlay).toBe('launcher');
    await userEvent.keyboard(' ');
    expect(sent).toEqual([STOP, STOP]);
    expect(screen.getByRole('dialog').elements()).toHaveLength(0);

    chunks.resolve();
    await expect.element(screen.getByRole('dialog')).toBeVisible();
    await userEvent.keyboard('{Escape}');
    await expect.element(screen.getByRole('dialog')).not.toBeInTheDocument();

    await userEvent.keyboard('/');
    expect(store.getState().overlay).toBe('drawer');
    await expect
      .element(screen.getByRole('searchbox', { name: 'Search the variables' }))
      .toBeVisible();
    await userEvent.keyboard(' ');
    expect(sent).toEqual([STOP, STOP, STOP]);
  });
});
