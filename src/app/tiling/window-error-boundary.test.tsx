import { describe, expect, test } from 'vitest';
import { render } from 'vitest-browser-react';

import { WindowErrorBoundary } from './window-error-boundary';

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
});
