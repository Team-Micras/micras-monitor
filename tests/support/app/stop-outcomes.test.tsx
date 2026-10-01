import { expect, onTestFinished, test } from 'vitest';
import { page } from 'vitest/browser';

import { recordStopOutcomes } from '@tests/support/app/stop-outcomes';

function stopOutcome(): HTMLOutputElement {
  const output = document.createElement('output');
  output.setAttribute('aria-label', 'Stop outcome');
  document.body.append(output);
  return output;
}

function show(output: HTMLOutputElement, text: string): Promise<void> {
  output.textContent = text;
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

test('records every text the Stop outcome shows', async () => {
  const output = stopOutcome();
  onTestFinished(() => output.remove());
  const shown = recordStopOutcomes(page.getByRole('status', { name: 'Stop outcome' }));
  await show(output, 'Stop accepted');
  await show(output, '');
  await show(output, 'Stop refused: not idle');
  expect(shown()).toBe('Stop accepted\nStop refused: not idle');
});

test('stops recording once its test finishes', async () => {
  const output = stopOutcome();
  let shown: (() => string) | undefined;
  onTestFinished(async () => {
    await show(output, 'Nothing to stop');
    output.remove();
    expect(shown?.()).toBe('Stop accepted');
  });
  shown = recordStopOutcomes(page.getByRole('status', { name: 'Stop outcome' }));
  await show(output, 'Stop accepted');
  expect(shown()).toBe('Stop accepted');
});
