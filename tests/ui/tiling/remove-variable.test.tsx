import { afterEach, describe, expect, test } from 'vitest';
import { userEvent } from 'vitest/browser';

import { createWorkspace, leaf } from '@/tiling';

import { mountShell, shellWindow, type ShellApp } from '@tests/support/ui/shell-app';
import '@/ui/styles.css';

const apps: ShellApp[] = [];

afterEach(() => {
  apps.splice(0).forEach(({ monitor }) => monitor.disconnect());
});

async function open(kind: string, names: readonly string[]): Promise<ShellApp> {
  const app = await mountShell(
    [createWorkspace('One', leaf('w'))],
    [shellWindow('w', kind, names)]
  );
  apps.push(app);
  return app;
}

function variables({ store }: ShellApp): readonly string[] | undefined {
  return store.getState().desktop.windows.get('w')?.payload.variables;
}

function removeButton(name: string): HTMLElement {
  const found = document.querySelector<HTMLElement>(`[data-series="${name}"] button`);

  if (found === null) {
    throw new Error(`no chip for ${name}`);
  }

  return found;
}

describe('the series chips of a window', () => {
  test('show a remove button on hover, which takes the variable out and can be undone', async () => {
    const app = await open('plot', ['pose/x', 'pose/y']);
    const { screen } = app;
    expect(getComputedStyle(removeButton('pose/x')).opacity).toBe('0');
    await userEvent.hover(screen.getByText('pose/x', { exact: true }));
    await expect.poll(() => getComputedStyle(removeButton('pose/x')).opacity).toBe('1');
    await screen.getByRole('button', { name: 'Remove pose/x from Plot' }).click();
    expect(variables(app)).toEqual(['pose/y']);
    const notice = screen.getByRole('status', { name: 'Variable removed' });
    await expect.element(notice).toHaveTextContent('Removed pose/x from Plot');
    await notice.getByRole('button', { name: 'Undo' }).click();
    expect(variables(app)).toEqual(['pose/x', 'pose/y']);
    await expect.element(notice).not.toBeInTheDocument();
  });

  test('take the variable out on Delete once focused, and Ctrl+Z puts it back', async () => {
    const app = await open('plot', ['pose/x', 'pose/y']);
    removeButton('pose/y').focus();
    await userEvent.keyboard('{Delete}');
    expect(variables(app)).toEqual(['pose/x']);
    await expect.element(app.screen.getByRole('region', { name: 'Plot' })).toHaveFocus();
    await userEvent.keyboard('{Control>}z{/Control}');
    expect(variables(app)).toEqual(['pose/x', 'pose/y']);
  });

  test('list the variables past the first three behind +N, where they can be removed', async () => {
    const app = await open('plot', ['a', 'b', 'c', 'd', 'e']);
    const { screen } = app;
    expect(document.querySelector('[data-series="d"]')).toBeNull();
    await screen.getByRole('button', { name: '2 more in Plot' }).click();
    const list = screen.getByRole('list', { name: 'More in Plot' });
    await expect.element(list.getByText('d', { exact: true })).toBeVisible();
    await list.getByRole('button', { name: 'Remove e from Plot' }).click();
    expect(variables(app)).toEqual(['a', 'b', 'c', 'd']);
    await expect.element(screen.getByRole('button', { name: '1 more in Plot' })).toBeVisible();
  });
});

describe('the window menu', () => {
  for (const [kind, title] of [
    ['plot', 'Plot'],
    ['readouts', 'Readouts'],
    ['editor', 'Editor'],
  ] as const) {
    test(`removes any variable of a ${title} window`, async () => {
      const app = await open(kind, ['a', 'b', 'c', 'd']);
      const { screen } = app;
      await screen.getByRole('button', { name: `${title} menu` }).click();
      await screen.getByRole('menuitem', { name: 'Remove variable' }).click();
      await screen.getByRole('menuitem', { name: 'd', exact: true }).click();
      expect(variables(app)).toEqual(['a', 'b', 'c']);
      await expect
        .element(screen.getByRole('status', { name: 'Variable removed' }))
        .toHaveTextContent(`Removed d from ${title}`);
    });
  }

  test('offers no removal for a window without variables', async () => {
    const { screen } = await open('plot', []);
    await screen.getByRole('button', { name: 'Plot menu' }).click();
    await expect.element(screen.getByRole('menuitem', { name: /Close/ })).toBeVisible();
    expect(screen.getByRole('menuitem', { name: 'Remove variable' }).query()).toBeNull();
  });
});
