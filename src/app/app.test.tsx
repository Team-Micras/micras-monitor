import { expect, test } from 'vitest';
import { render } from 'vitest-browser-react';

import { App } from './app';

test('renders the placeholder', async () => {
  const screen = await render(<App />);

  await expect.element(screen.getByRole('heading', { name: 'Micras Monitor' })).toBeVisible();
  await expect.element(screen.getByText('em reconstrução')).toBeVisible();
});
