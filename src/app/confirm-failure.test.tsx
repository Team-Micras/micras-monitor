import { createElement, type ReactNode } from 'react';
import { describe, expect, test, vi } from 'vitest';
import { userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-react';

import { RobotRegistry } from '@/robot-kit';
import { mouse } from '@/robot-kit/fixtures/packages';

import { App } from './app';
import { createDemoRobot } from './fake/demo-robot';
import './styles.css';
import { createShellStore } from './state/shell-store';
import type { CommandConfirmProps } from './windows/commands/command-confirm';

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
    { code: 5, name: 'STOP', label: 'Stop', acceptedIn: 'any', emergency: true },
  ],
});

const dialog = vi.hoisted(() => ({ broken: true }));

vi.mock('./windows/commands/command-confirm', async (importOriginal) => {
  const original = await importOriginal<typeof import('./windows/commands/command-confirm')>();

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
    const robot = createDemoRobot({ connectMs: 5, handshakeMs: 10, configureMs: 5, commandMs: 5 });
    const sent: number[] = [];
    const screen = await render(
      <App
        ports={{
          ...robot.ports,
          commands: {
            send: (code, argument) => {
              sent.push(code);
              return robot.ports.commands.send(code, argument);
            },
          },
        }}
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
