import { describe, expect, test } from 'vitest';
import { render } from 'vitest-browser-react';

import type { Gutter } from '@/tiling';

import '@/ui/styles.css';
import { createShellStore, ShellStoreContext } from '@/ui/state/shell-store';
import { GutterHandle } from '@/ui/tiling/split-handle';

const GUTTER: Gutter = {
  path: '',
  orientation: 'row',
  rect: { x: 100, y: 0, width: 14, height: 200 },
  span: { x: 0, y: 0, width: 400, height: 200 },
  ratio: 0.123,
  minRatio: 0.123,
  maxRatio: 0.877,
  between: ['first', 'second'],
};

describe('GutterHandle', () => {
  test('keeps its value inside its own bounds however the ratios round', async () => {
    const screen = await render(
      <ShellStoreContext value={createShellStore()}>
        <GutterHandle gutter={GUTTER} label="Resize First and Second" />
      </ShellStoreContext>
    );
    const splitter = screen.getByRole('separator', { name: 'Resize First and Second' });
    await expect.element(splitter).toHaveAttribute('aria-valuemin', '13');
    await expect.element(splitter).toHaveAttribute('aria-valuenow', '13');
    await expect.element(splitter).toHaveAttribute('aria-valuemax', '87');
    await expect.element(splitter).toHaveAttribute('aria-controls', 'window-first');
  });
});
