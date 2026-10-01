import { expect, onTestFinished, test } from 'vitest';
import { page } from 'vitest/browser';

import { recordCommandOutcomes } from '@tests/support/ui/command-outcomes';

function commandOutcome(): HTMLOutputElement {
  const output = document.createElement('output');
  output.setAttribute('aria-label', 'Command outcome');
  document.body.append(output);
  return output;
}

function show(output: HTMLOutputElement, text: string): Promise<void> {
  output.textContent = text;
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

test('records every text the Command outcome shows', async () => {
  const output = commandOutcome();
  onTestFinished(() => output.remove());
  const shown = recordCommandOutcomes(page.getByRole('status', { name: 'Command outcome' }));
  await show(output, 'Stop accepted');
  await show(output, '');
  await show(output, 'Stop refused: not idle');
  expect(shown()).toBe('Stop accepted\nStop refused: not idle');
});

test('stops recording once its test finishes', async () => {
  const output = commandOutcome();
  let shown: (() => string) | undefined;
  onTestFinished(async () => {
    await show(output, 'No robot to send Stop to');
    output.remove();
    expect(shown?.()).toBe('Stop accepted');
  });
  shown = recordCommandOutcomes(page.getByRole('status', { name: 'Command outcome' }));
  await show(output, 'Stop accepted');
  expect(shown()).toBe('Stop accepted');
});
