import { afterEach, describe, expect, test } from 'vitest';

import { tabbableIn, trapTab } from '@/app/shell/focus-trap';

function panel(html: string): HTMLElement {
  const root = document.createElement('div');
  root.innerHTML = html;
  document.body.append(root);
  return root;
}

afterEach(() => {
  document.body.replaceChildren();
});

describe('tabbableIn', () => {
  test('leaves out controls that are hidden or out of the Tab order', () => {
    const root = panel(
      '<button>a</button><button style="display:none">hidden</button><button tabindex="-1">skipped</button><button>b</button>'
    );

    expect(tabbableIn(root).map((element) => element.textContent)).toEqual(['a', 'b']);
  });
});

describe('trapTab', () => {
  test('wraps from the last reachable control even when a hidden one follows it', () => {
    const root = panel(
      '<button>first</button><button>last</button><button style="display:none">hidden</button><button tabindex="-1">skipped</button>'
    );
    const [first, last] = tabbableIn(root);
    last?.focus();
    const event = new KeyboardEvent('keydown', { key: 'Tab', cancelable: true });

    trapTab(event, root);

    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(first);
  });
});
