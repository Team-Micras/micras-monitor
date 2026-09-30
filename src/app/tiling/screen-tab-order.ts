import { useEffect, useEffectEvent, type RefObject } from 'react';

import type { WindowId } from '@/tiling';

import { TABBABLE } from '../shell/focus-trap';

/** The windows Tab visits, in screen order; the gaps between them come after the tiles. */
export interface ScreenOrder {
  readonly tiled: readonly WindowId[];
  readonly floating: readonly WindowId[];
}

interface Stop {
  readonly root: HTMLElement;
  readonly controls: readonly HTMLElement[];
}

function reachable(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(TABBABLE)].filter(
    (element) => element.closest('[inert]') === null
  );
}

function stopsOf(container: HTMLElement, order: ScreenOrder): Stop[] {
  const window = (id: WindowId) =>
    container.querySelector<HTMLElement>(`[data-window="${CSS.escape(id)}"]`);
  const roots = [
    ...order.tiled.map(window),
    ...container.querySelectorAll<HTMLElement>('[data-gutter]'),
    ...order.floating.map(window),
  ];
  return roots.flatMap((root) => {
    if (root === null || root.closest('[inert]') !== null) {
      return [];
    }

    const inside = reachable(root);
    const own = root.hasAttribute('data-gutter') ? [root] : [];
    return [{ root, controls: [...own, ...inside] }];
  });
}

function outside(container: HTMLElement, forward: boolean): HTMLElement | undefined {
  const others = [...document.querySelectorAll<HTMLElement>(TABBABLE)].filter(
    (element) =>
      !container.contains(element) &&
      element.closest('[inert]') === null &&
      element.getClientRects().length > 0 &&
      Boolean(
        container.compareDocumentPosition(element) &
        (forward ? Node.DOCUMENT_POSITION_FOLLOWING : Node.DOCUMENT_POSITION_PRECEDING)
      )
  );
  return forward ? others.at(0) : others.at(-1);
}

function enter(stop: Stop | undefined, last: boolean): void {
  const target = last ? stop?.controls.at(-1) : stop?.controls.at(0);
  (target ?? stop?.root)?.focus();
}

/**
 * Makes Tab and Shift+Tab visit the windows of a tiling by where they are on screen, top-left to
 * bottom-right, then the gaps, then the floating windows, while the windows stay in the page in
 * the order they were opened, so moving one never remounts it or resets its scroll. Inside a
 * window, Tab follows the page as usual; at its last control it goes to the next window on
 * screen, and from the outside it enters at the first (or, with Shift, the last).
 *
 * @param container The tiling's element.
 * @param order The windows on screen, in the order to visit them.
 */
export function useScreenTabOrder(
  container: RefObject<HTMLElement | null>,
  order: ScreenOrder
): void {
  const current = useEffectEvent(() => order);

  useEffect(() => {
    const element = container.current;

    if (element === null) {
      return undefined;
    }

    let tabbing = false;

    const onKeyDown = (event: KeyboardEvent) => {
      const { target } = event;

      if (
        event.key !== 'Tab' ||
        event.ctrlKey ||
        event.altKey ||
        event.metaKey ||
        !(target instanceof HTMLElement)
      ) {
        return;
      }

      const stops = stopsOf(element, current());
      const at = stops.findIndex((stop) => stop.root.contains(target));
      const stop = stops[at];

      if (stop === undefined) {
        return;
      }

      const position = stop.controls.indexOf(target);
      const first = stop.controls.at(0);
      const inside = event.shiftKey
        ? position > 0
        : position >= 0 && position < stop.controls.length - 1;

      if (inside) {
        return;
      }

      event.preventDefault();

      if (position === -1 && !event.shiftKey && first !== undefined) {
        first.focus();
        return;
      }

      const next = stops[at + (event.shiftKey ? -1 : 1)];

      if (next === undefined) {
        outside(element, !event.shiftKey)?.focus();
      } else {
        enter(next, event.shiftKey);
      }
    };

    const onFocusIn = (event: FocusEvent) => {
      const from = event.relatedTarget;

      if (!tabbing || (from instanceof Node && element.contains(from))) {
        return;
      }

      const stops = stopsOf(element, current());
      const backwards =
        from instanceof Node &&
        Boolean(element.compareDocumentPosition(from) & Node.DOCUMENT_POSITION_FOLLOWING);
      const entry = stops.at(backwards ? -1 : 0);

      if (
        entry !== undefined &&
        event.target !== (backwards ? entry.controls.at(-1) : entry.controls.at(0))
      ) {
        enter(entry, backwards);
      }
    };

    const remember = (event: KeyboardEvent) => {
      tabbing = event.key === 'Tab';
    };
    const forget = () => {
      tabbing = false;
    };

    document.addEventListener('keydown', remember, true);
    document.addEventListener('pointerdown', forget, true);
    element.addEventListener('keydown', onKeyDown);
    element.addEventListener('focusin', onFocusIn);

    return () => {
      document.removeEventListener('keydown', remember, true);
      document.removeEventListener('pointerdown', forget, true);
      element.removeEventListener('keydown', onKeyDown);
      element.removeEventListener('focusin', onFocusIn);
    };
  }, [container]);
}
