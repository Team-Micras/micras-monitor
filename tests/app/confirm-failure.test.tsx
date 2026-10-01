import { createElement, type ReactNode } from 'react';
import { describe, expect, test, vi } from 'vitest';
import { userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-react';

import { RobotRegistry } from '@/robot-kit';
import { mouse } from '@tests/support/robot-kit/packages';
import { demoMonitor, recordCommands } from '@tests/support/sources/demo-monitor';

import { App } from '@/app/app';
import '@/app/styles.css';
import { createShellStore } from '@/app/state/shell-store';
import type { CommandConfirmProps } from '@/app/windows/commands/command-confirm';

const PACKAGE = mouse({
  id: 'micras',
  displayName: 'Micras',
  roles: { state: 'state' },
  commands: [
    {
      code: 3,
      name: 'SAVE',
      label: 'Save',
      confirm: 'Save the maze to the flash?',
      acceptedIn: 'any',
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
});

const dialog = vi.hoisted(() => ({ broken: true }));

vi.mock('@/app/windows/commands/command-confirm', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/app/windows/commands/command-confirm')>();

  return {
    CommandConfirm: (props: CommandConfirmProps) => {
      if (dialog.broken) {
        throw new Error('Failed to fetch dynamically imported module');
      }

      return createElement(original.CommandConfirm, props);
    },
  };
});

describe('the confirmation of a dangerous command whose code fails to load', () => {
  test('says so, sends nothing, and opens on the next press once the code loads', async () => {
    const sent: number[] = [];
    const screen = await render(
      <App
        monitor={demoMonitor({ command: recordCommands(sent) })}
        robots={new RobotRegistry<ReactNode>([PACKAGE])}
        store={createShellStore({ theme: 'dark' })}
        synthetic
      />
    );
    await screen.getByRole('button', { name: 'Connect', exact: true }).click();
    await screen.getByRole('dialog').getByRole('button', { name: 'Connect' }).click();
    await expect.element(screen.getByText('· connected')).toBeVisible();
    await userEvent.keyboard('{Escape}');
    await expect.element(screen.getByRole('dialog')).not.toBeInTheDocument();

    const save = screen.getByRole('button', { name: 'Save' });
    await save.click();
    await expect
      .element(screen.getByText("Couldn't open the confirmation — reload").first())
      .toBeVisible();
    expect(sent).toEqual([]);

    dialog.broken = false;
    await save.click();
    await expect
      .element(screen.getByRole('dialog'))
      .toHaveTextContent('Save the maze to the flash?');
  });
});
