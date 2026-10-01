import { afterEach, describe, expect, test } from 'vitest';
import { userEvent } from 'vitest/browser';

import { createWorkspace, leaf } from '@/tiling';

import { mountShell, shellWindow, type ShellApp } from '@tests/support/app/shell-app';
import '@/app/styles.css';

const apps: ShellApp[] = [];

afterEach(() => {
  apps.splice(0).forEach(({ robot }) => robot.disconnect());
});

describe('the launcher', () => {
  test('puts the focus in its search field when opened again right after Esc', async () => {
    const app = await mountShell([createWorkspace('One', leaf('w'))], [shellWindow('w', 'log')]);
    apps.push(app);
    const input = app.screen.getByPlaceholder('Open a window or run an action…');
    await userEvent.keyboard('{Control>}k{/Control}');
    await expect.element(input).toHaveFocus();
    await userEvent.keyboard('{Escape}');
    await userEvent.keyboard('{Control>}k{/Control}');
    await expect.element(input).toHaveFocus();
    await userEvent.keyboard('log');
    await expect.element(input).toHaveValue('log');
  });
});
