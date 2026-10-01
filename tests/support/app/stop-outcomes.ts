/**
 * What the Stop outcome of the top bar showed, for tests. A notice clears itself a few seconds
 * after the answer, so on a loaded machine a test that looks for it on screen can arrive after it
 * is gone; recording every text it shows lets the test check what a press came to whenever it
 * gets there.
 *
 * @module
 */

import { onTestFinished } from 'vitest';
import type { Locator } from 'vitest/browser';

/**
 * Starts recording the texts the Stop outcome shows, until the test finishes.
 *
 * @param outcome - The Stop outcome, found the way a reader finds it:
 *   `getByRole('status', { name: 'Stop outcome' })`. It must be on screen already.
 * @returns What it showed so far, one notice per line.
 */
export function recordStopOutcomes(outcome: Locator): () => string {
  const output = outcome.element();
  const shown: string[] = [];
  const record = () => {
    const text = output.textContent ?? '';

    if (text !== '' && shown.at(-1) !== text) {
      shown.push(text);
    }
  };
  const observer = new MutationObserver(record);
  observer.observe(output, { childList: true, subtree: true, characterData: true });
  onTestFinished(() => observer.disconnect());
  record();
  return () => shown.join('\n');
}
