/**
 * A browser command that drives the real mouse of the test page, for tests that hold a drag
 * midway to look at it: each step goes through Playwright's `page.mouse`, so the browser itself
 * fires the pointer events, with hit testing, capture and clicks as a person's mouse would.
 *
 * @module
 */

import type { BrowserCommand } from 'vitest/node';

/** One step of the mouse, in the client pixels of the page under test. */
export type MouseStep =
  | { readonly type: 'move'; readonly x: number; readonly y: number; readonly steps?: number }
  | { readonly type: 'down' }
  | { readonly type: 'up' };

declare module 'vitest/browser' {
  interface BrowserCommands {
    /** Moves, presses and releases the real mouse, step by step. */
    mouse: (steps: readonly MouseStep[]) => Promise<void>;
  }
}

/** Runs mouse steps in the test's frame, whose client pixels it maps onto the page. */
export const mouse: BrowserCommand<[steps: readonly MouseStep[]]> = async (context, steps) => {
  if (!('page' in context) || !('frame' in context)) {
    throw new Error('the mouse command needs the Playwright provider');
  }

  const frame = await context.frame();
  const box = await (await frame.frameElement()).boundingBox();
  const width = Number(await frame.evaluate('document.documentElement.clientWidth'));

  if (box === null) {
    throw new Error('the test frame is not on the page');
  }

  const scale = width > 0 ? box.width / width : 1;

  for (const step of steps) {
    if (step.type === 'move') {
      await context.page.mouse.move(box.x + step.x * scale, box.y + step.y * scale, {
        steps: step.steps ?? 1,
      });
    } else if (step.type === 'down') {
      await context.page.mouse.down();
    } else {
      await context.page.mouse.up();
    }
  }
};
