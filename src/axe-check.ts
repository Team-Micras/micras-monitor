import axe from 'axe-core';

import { settled } from './app/fixtures/animations';

/**
 * Runs axe over the page once its transitions have ended, since colours in a fading dialog are
 * half-way, and describes every serious or critical violation, one line each with the elements
 * it found; an empty list is a pass.
 */
export async function seriousViolations(root: Element = document.body): Promise<string[]> {
  await settled();
  const { violations } = await axe.run(root, { resultTypes: ['violations'] });
  return violations
    .filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')
    .map(
      (violation) =>
        `${violation.impact} ${violation.id}: ${violation.nodes
          .map((node) => `${node.target.join(' ')} ${node.html.slice(0, 160)}`)
          .join(' | ')}`
    );
}
