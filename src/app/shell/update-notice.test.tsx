import { describe, expect, test } from 'vitest';
import { render } from 'vitest-browser-react';

import { PRELOAD_ERROR_EVENT, UpdateNotice } from './update-notice';

describe('UpdateNotice', () => {
  test('says that part of the app could not load once a preload fails, with a reload button', async () => {
    const screen = await render(<UpdateNotice />);
    await expect.element(screen.getByRole('status')).not.toBeInTheDocument();

    window.dispatchEvent(new Event(PRELOAD_ERROR_EVENT));
    await expect
      .element(screen.getByRole('status'))
      .toHaveTextContent("Couldn't load part of the app");
    await expect.element(screen.getByRole('button', { name: 'Reload' })).toBeVisible();
  });
});
