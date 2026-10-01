import { describe, expect, test } from 'vitest';
import { render } from 'vitest-browser-react';

import { seriousViolations } from '@tests/support/axe-check';
import { Announcer } from '@/ui/shell/a11y/announcer';
import { WindowErrorBoundary } from '@/ui/tiling/window-error-boundary';

const load = { broken: true };

function View({ crash = false }: { readonly crash?: boolean }) {
  if (load.broken || crash) {
    throw new Error('Failed to fetch dynamically imported module');
  }

  return <p>Loaded</p>;
}

describe('WindowErrorBoundary', () => {
  test('hints at a reload only after a retry failed, and forgets it once a load succeeded', async () => {
    load.broken = true;
    const screen = await render(
      <WindowErrorBoundary>
        <View />
      </WindowErrorBoundary>
    );
    const hint = screen.getByText('Some browsers keep a failed load until the page reloads.');
    await expect.element(screen.getByText("Couldn't load this window")).toBeVisible();
    await expect.element(hint).not.toBeInTheDocument();

    await screen.getByRole('button', { name: 'Retry' }).click();
    await expect.element(hint).toBeVisible();

    load.broken = false;
    await screen.getByRole('button', { name: 'Retry' }).click();
    await expect.element(screen.getByText('Loaded')).toBeVisible();

    await screen.rerender(
      <WindowErrorBoundary>
        <View crash />
      </WindowErrorBoundary>
    );
    await expect.element(screen.getByText("Couldn't load this window")).toBeVisible();
    await expect.element(hint).not.toBeInTheDocument();
  });

  test('announces the window that failed to load, once, by its title', async () => {
    load.broken = true;
    const screen = await render(
      <Announcer>
        <WindowErrorBoundary title="Maze">
          <View />
        </WindowErrorBoundary>
      </Announcer>
    );
    await expect.element(screen.getByText("Couldn't load this window")).toBeVisible();
    await expect
      .poll(() => document.querySelector('[data-announcer="polite"]')?.textContent)
      .toBe("Couldn't load Maze");
    expect(await seriousViolations()).toEqual([]);
  });
});
