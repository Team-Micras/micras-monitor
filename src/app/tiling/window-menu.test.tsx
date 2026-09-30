import { afterEach, describe, expect, test } from 'vitest';
import { userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-react';

import { RobotRegistry } from '@/robot-kit';
import { mouse } from '@/robot-kit/fixtures/packages';
import { activeWorkspace, createDesktop, createWorkspace, leaf, leafIds, split } from '@/tiling';

import { App } from '../app';
import { createDemoRobot } from '../fake/demo-robot';
import type { FakeRobot } from '../fake/fake-robot';
import { settled } from '../fixtures/animations';
import { createShellStore, type ShellStore } from '../state/shell-store';
import '../styles.css';

const robots: FakeRobot[] = [];

afterEach(() => {
  robots.splice(0).forEach((robot) => robot.disconnect());
});

async function open() {
  const robot = createDemoRobot({ connectMs: 5, handshakeMs: 10, configureMs: 5 });
  robots.push(robot);
  const store = createShellStore({
    theme: 'dark',
    desktop: createDesktop(
      [
        createWorkspace('One', split('row', 0.5, leaf('a'), leaf('b'))),
        createWorkspace('Two', null),
      ],
      [
        { id: 'a', kind: 'readouts', payload: { variables: [] } },
        { id: 'b', kind: 'log', payload: { variables: [] } },
      ]
    ),
  });
  const screen = await render(
    <App
      ports={robot.ports}
      robots={new RobotRegistry([mouse({ id: 'micras' })])}
      store={store}
      synthetic
    />
  );
  await settled();
  return { store, screen };
}

function ids(store: ShellStore, workspace = store.getState().desktop.active) {
  return leafIds(store.getState().desktop.workspaces[workspace].root);
}

function floating(store: ShellStore) {
  return activeWorkspace(store.getState().desktop).floating.map((entry) => entry.id);
}

function maximized(store: ShellStore) {
  return activeWorkspace(store.getState().desktop).maximized;
}

describe('the window menu, clicked with the pointer', () => {
  test('maximizes the window it belongs to and restores it', async () => {
    const { store, screen } = await open();
    await screen.getByRole('button', { name: 'Log menu' }).click();
    await screen.getByRole('menuitem', { name: /Maximize/ }).click();
    await expect.poll(() => maximized(store)).toBe('b');
    await screen.getByRole('button', { name: 'Log menu' }).click();
    await screen.getByRole('menuitem', { name: /Restore/ }).click();
    await expect.poll(() => maximized(store)).toBeNull();
  });

  test('floats the window and tiles it again', async () => {
    const { store, screen } = await open();
    await screen.getByRole('button', { name: 'Readouts menu' }).click();
    await screen.getByRole('menuitem', { name: /Float/ }).click();
    await expect.poll(() => floating(store)).toEqual(['a']);
    await settled();
    await screen.getByRole('button', { name: 'Readouts menu' }).click();
    await screen.getByRole('menuitem', { name: /Tile/ }).click();
    await expect.poll(() => floating(store)).toEqual([]);
  });

  test('moves the window to another workspace', async () => {
    const { store, screen } = await open();
    await screen.getByRole('button', { name: 'Log menu' }).click();
    await screen.getByRole('menuitem', { name: 'Move to workspace' }).click();
    await screen.getByRole('menuitem', { name: 'Two' }).click();
    await expect.poll(() => ids(store, 1)).toEqual(['b']);
    expect(ids(store, 0)).toEqual(['a']);
  });

  test('closes the window', async () => {
    const { store, screen } = await open();
    await screen.getByRole('button', { name: 'Log menu' }).click();
    await screen.getByRole('menuitem', { name: /Close/ }).click();
    await expect.poll(() => ids(store)).toEqual(['a']);
  });
});

describe('the window keys', () => {
  test('maximize, float and close the focused window', async () => {
    const { store } = await open();
    await userEvent.keyboard('{Alt>}f{/Alt}');
    await expect.poll(() => maximized(store)).toBe('a');
    await userEvent.keyboard('{Alt>}f{/Alt}');
    await expect.poll(() => maximized(store)).toBeNull();
    await userEvent.keyboard('{Alt>}o{/Alt}');
    await expect.poll(() => floating(store)).toEqual(['a']);
    await userEvent.keyboard('{Alt>}q{/Alt}');
    await expect.poll(() => [...store.getState().desktop.windows.keys()]).toEqual(['b']);
  });
});

describe('the workspace tab menu', () => {
  test('closes a workspace from a right click, keeping its windows', async () => {
    const { store, screen } = await open();
    await screen.getByRole('tab', { name: 'One' }).click({ button: 'right' });
    await screen.getByRole('menuitem', { name: /keep its windows/ }).click();
    await expect
      .poll(() => store.getState().desktop.workspaces.map((ws) => ws.name))
      .toEqual(['Two']);
    expect(ids(store, 0)).toEqual(['a', 'b']);
  });
});
