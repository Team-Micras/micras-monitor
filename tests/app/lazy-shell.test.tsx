import { createElement, type ReactNode } from 'react';
import { describe, expect, test, vi } from 'vitest';
import { userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-react';

import { RobotRegistry } from '@/robot-kit';
import { mouse } from '@tests/support/robot-kit/packages';
import { DEMO_TARGET, demoMonitor, recordCommands } from '@tests/support/sources/demo-monitor';

import { App } from '@/app/app';
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
    const sent: number[] = [];
    const monitor = demoMonitor({ command: recordCommands(sent) });
    const store = createShellStore({ theme: 'dark' });
    const screen = await render(
      createElement(App, {
        monitor,
        robots: new RobotRegistry<ReactNode>([mouse({ id: 'micras', displayName: 'Micras' })]),
        store,
        synthetic: true,
      })
    );
    monitor.connect(DEMO_TARGET);
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
