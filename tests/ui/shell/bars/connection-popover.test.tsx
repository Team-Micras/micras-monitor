import { afterEach, describe, expect, test } from 'vitest';

import { createWorkspace, leaf } from '@/tiling';

import { mountShell, shellWindow, type ShellApp } from '@tests/support/ui/shell-app';
import '@/ui/styles.css';

const apps: ShellApp[] = [];

afterEach(() => {
  apps.splice(0).forEach(({ monitor }) => monitor.disconnect());
});

describe('the connection popover', () => {
  test('shows the address the monitor was told to connect to, not the stored default', async () => {
    const app = await mountShell([createWorkspace('One', leaf('w'))], [shellWindow('w', 'log')]);
    apps.push(app);
    app.monitor.connect({ transport: 'websocket', url: 'ws://100.64.0.1:8080' });
    app.store.getState().setConnectionOpen(true);

    await expect.element(app.screen.getByLabelText('Address')).toHaveValue('ws://100.64.0.1:8080');
  });
});
