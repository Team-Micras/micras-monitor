import { afterEach, describe, expect, test } from 'vitest';
import { userEvent } from 'vitest/browser';

import { createWorkspace, leaf, split } from '@/tiling';

import { settled } from '../fixtures/animations';
import { drag, moveTo, pointIn, press, release } from '../fixtures/mouse';
import {
  mountShell,
  shellWindow,
  tiledIds,
  workspaceNames,
  type ShellApp,
} from '../fixtures/shell-app';
import '../styles.css';

const apps: ShellApp[] = [];

afterEach(async () => {
  await release();
  apps.splice(0).forEach(({ robot }) => robot.disconnect());
});

async function open(): Promise<ShellApp> {
  const app = await mountShell(
    [
      createWorkspace('One', split('row', 0.5, leaf('a'), leaf('b'))),
      createWorkspace('Two', leaf('c')),
      createWorkspace('Three'),
    ],
    [shellWindow('a', 'readouts'), shellWindow('b', 'log'), shellWindow('c', 'log')]
  );
  apps.push(app);
  return app;
}

function tab(name: string): HTMLElement {
  const found = [...document.querySelectorAll<HTMLElement>('[role="tab"]')].find(
    (element) => element.textContent === name
  );

  if (found === undefined) {
    throw new Error(`no tab ${name}`);
  }

  return found;
}

function indicator(): string | null {
  return (
    document.querySelector('[data-tab-drop-indicator]')?.getAttribute('data-tab-drop-indicator') ??
    null
  );
}

async function launch(screen: ShellApp['screen'], command: string): Promise<void> {
  await userEvent.keyboard('{Control>}k{/Control}');
  const input = screen.getByPlaceholder('Open a window or run an action…');
  await expect.element(input).toHaveFocus();
  await input.fill(command);
  await userEvent.keyboard('{Enter}');
  await expect.element(screen.getByRole('dialog', { name: 'Launcher' })).not.toBeInTheDocument();
}

describe('dragging a workspace tab', () => {
  test('shows where it would go and moves the workspace there on release', async () => {
    const { store } = await open();
    const from = pointIn(tab('Two'));
    await press(from, pointIn(tab('Three'), 0.9));
    await expect.poll(indicator).toBe('3');
    expect(tab('Two').dataset.reordering).toBe('true');
    await moveTo(pointIn(tab('One'), 0.1));
    await expect.poll(indicator).toBe('0');
    await release();
    await expect.poll(() => workspaceNames(store)).toEqual(['Two', 'One', 'Three']);
    expect(indicator()).toBeNull();
    expect(store.getState().desktop.active).toBe(1);
  });

  test('shows no indicator next to where the tab already is', async () => {
    const { store } = await open();
    const from = pointIn(tab('Two'));
    await press(from, pointIn(tab('Two'), 0.8));
    await expect.poll(() => tab('Two').dataset.reordering).toBe('true');
    expect(indicator()).toBeNull();
    await release();
    expect(workspaceNames(store)).toEqual(['One', 'Two', 'Three']);
    expect(store.getState().desktop.active).toBe(0);
  });

  test('still shows the workspace when clicked without moving', async () => {
    const { store } = await open();
    await drag(pointIn(tab('Three')), pointIn(tab('Three'), 0.52));
    await expect.poll(() => store.getState().desktop.active).toBe(2);
    expect(workspaceNames(store)).toEqual(['One', 'Two', 'Three']);
  });

  test('leaves dropping a window on a tab to move the window there', async () => {
    const { store } = await open();
    const title = document.querySelector('[data-window="b"] h2');

    if (title === null) {
      throw new Error('no title');
    }

    await press(pointIn(title), pointIn(tab('Three')));
    await expect.poll(() => tab('Three').className).toContain('ring-2');
    expect(indicator()).toBeNull();
    await release();
    await expect.poll(() => tiledIds(store, 2)).toEqual(['b']);
    expect(workspaceNames(store)).toEqual(['One', 'Two', 'Three']);
  });
});

describe('moving a workspace from the keyboard', () => {
  test('takes the shown workspace a place right and left', async () => {
    const { store } = await open();
    await userEvent.keyboard('{Alt>}{Shift>}{PageDown}{/Shift}{/Alt}');
    await expect.poll(() => workspaceNames(store)).toEqual(['Two', 'One', 'Three']);
    expect(store.getState().desktop.active).toBe(1);
    await userEvent.keyboard('{Alt>}{Shift>}{PageUp}{/Shift}{/Alt}');
    await expect.poll(() => workspaceNames(store)).toEqual(['One', 'Two', 'Three']);
  });

  test('from the launcher, which shows the keys', async () => {
    const { store, screen } = await open();
    await userEvent.keyboard('{Control>}k{/Control}');
    const input = screen.getByPlaceholder('Open a window or run an action…');
    await expect.element(input).toHaveFocus();
    await input.fill('move workspace one right');
    await expect
      .element(screen.getByRole('option', { name: /Move One right/ }))
      .toHaveTextContent('Alt+Shift+PgDn');
    await userEvent.keyboard('{Enter}');
    await expect.poll(() => workspaceNames(store)).toEqual(['Two', 'One', 'Three']);
  });

  test('from the tab menu', async () => {
    const { store, screen } = await open();
    await screen.getByRole('tab', { name: 'Three' }).click({ button: 'right' });
    await screen.getByRole('menuitem', { name: 'Move left' }).click();
    await expect.poll(() => workspaceNames(store)).toEqual(['One', 'Three', 'Two']);
  });
});

describe('closing a workspace', () => {
  test('with its windows asks first, and closes them', async () => {
    const { store, screen } = await open();
    await screen.getByRole('tab', { name: 'One' }).click({ button: 'right' });
    await screen.getByRole('menuitem', { name: /Close workspace and its windows/ }).click();
    const dialog = screen.getByRole('dialog', { name: 'Close One?' });
    await expect.element(dialog.getByRole('radio', { name: 'Close them with it' })).toBeChecked();
    await dialog.getByRole('button', { name: 'Close workspace and 2 windows' }).click();
    await expect.poll(() => workspaceNames(store)).toEqual(['Two', 'Three']);
    expect([...store.getState().desktop.windows.keys()]).toEqual(['c']);
  });

  test('keeps everything when the question is cancelled', async () => {
    const { store, screen } = await open();
    await screen.getByRole('tab', { name: 'One' }).click({ button: 'right' });
    await screen.getByRole('menuitem', { name: /Close workspace and its windows/ }).click();
    await screen.getByRole('button', { name: 'Cancel' }).click();
    await expect.element(screen.getByRole('dialog')).not.toBeInTheDocument();
    expect(workspaceNames(store)).toEqual(['One', 'Two', 'Three']);
    expect(store.getState().desktop.windows.size).toBe(3);
  });

  test('that is empty closes at once', async () => {
    const { store, screen } = await open();
    await screen.getByRole('tab', { name: 'Three' }).click({ button: 'right' });
    await expect
      .element(screen.getByRole('menuitem', { name: /move its windows/ }))
      .not.toBeInTheDocument();
    await screen.getByRole('menuitem', { name: 'Close workspace' }).click();
    await expect.poll(() => workspaceNames(store)).toEqual(['One', 'Two']);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  test('moving its windows to a workspace picked from the menu, the neighbor first', async () => {
    const { store, screen } = await open();
    await screen.getByRole('tab', { name: 'Two' }).click({ button: 'right' });
    await screen.getByRole('menuitem', { name: /move its windows to/ }).click();
    const items = screen.getByRole('menu').last().getByRole('menuitem');
    await expect.element(items.first()).toHaveTextContent('One');
    await screen.getByRole('menuitem', { name: 'Three' }).click();
    await expect.poll(() => workspaceNames(store)).toEqual(['One', 'Three']);
    expect(tiledIds(store, 1)).toEqual(['c']);
    expect(store.getState().desktop.windows.size).toBe(3);
  });

  test('from the keyboard, moving its windows to the neighbor unless another is picked', async () => {
    const { store, screen } = await open();
    await userEvent.keyboard('{Alt>}{Shift>}w{/Shift}{/Alt}');
    const dialog = screen.getByRole('dialog', { name: 'Close One?' });
    await expect.element(dialog.getByRole('radio', { name: 'Move them to Two' })).toBeChecked();
    await dialog.getByRole('radio', { name: 'Move them to Three' }).click();
    await dialog.getByRole('button', { name: 'Close workspace' }).click();
    await expect.poll(() => workspaceNames(store)).toEqual(['Two', 'Three']);
    expect(tiledIds(store, 1)).toEqual(['a', 'b']);
    expect(store.getState().desktop.active).toBe(1);
  });

  test('from the launcher, with or without its windows', async () => {
    const { store, screen } = await open();
    await launch(screen, 'close workspace one move its windows');
    await expect.element(screen.getByRole('radio', { name: 'Move them to Two' })).toBeChecked();
    await screen.getByRole('button', { name: 'Cancel' }).click();
    await expect.element(screen.getByRole('dialog')).not.toBeInTheDocument();
    await settled();
    await launch(screen, 'close workspace one and its windows');
    await expect.element(screen.getByRole('radio', { name: 'Close them with it' })).toBeChecked();
    await userEvent.keyboard('{Escape}');
    expect(workspaceNames(store)).toEqual(['One', 'Two', 'Three']);
  });
});
