/**
 * What the Stop outcome of the top bar showed, for tests. A notice clears itself a few seconds
 * after the answer, so on a loaded machine a test that looks for it on screen can arrive after it
 * is gone; recording every text it shows lets the test check what a press came to whenever it
 * gets there.
 *
 * @module
 */

/**
 * Starts recording the texts the Stop outcome shows.
 *
 * @returns What it showed so far, one notice per line.
 */
export function recordStopOutcomes(): () => string {
  const output = document.querySelector('output[aria-label="Stop outcome"]');

  if (output === null) {
    throw new Error('The top bar has no Stop outcome');
  }

  const shown: string[] = [];
  const record = () => {
    const text = output.textContent ?? '';

    if (text !== '' && shown.at(-1) !== text) {
      shown.push(text);
    }
  };
  new MutationObserver(record).observe(output, {
    childList: true,
    subtree: true,
    characterData: true,
  });
  record();
  return () => shown.join('\n');
}
