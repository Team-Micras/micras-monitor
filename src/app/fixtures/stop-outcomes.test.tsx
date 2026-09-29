import { afterAll, expect, test } from 'vitest';
import { page } from 'vitest/browser';

import { recordStopOutcomes } from './stop-outcomes';

const output = document.createElement('output');
output.setAttribute('aria-label', 'Stop outcome');
document.body.append(output);
let shown: () => string = () => '';

function show(text: string): Promise<void> {
  output.textContent = text;
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

afterAll(() => output.remove());

test('records every text the Stop outcome shows', async () => {
  shown = recordStopOutcomes(page.getByRole('status', { name: 'Stop outcome' }));
  await show('Stop accepted');
  await show('');
  await show('Stop refused: not idle');
  expect(shown()).toBe('Stop accepted\nStop refused: not idle');
});

test('stops recording when its test finishes', async () => {
  await show('Nothing to stop');
  expect(shown()).toBe('Stop accepted\nStop refused: not idle');
});
