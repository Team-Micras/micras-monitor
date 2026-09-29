/**
 * Colors of the theme the document shows, for what draws on a canvas and cannot use CSS
 * variables.
 *
 * @module
 */

import { useSyncExternalStore } from 'react';

const SEPARATOR = '\n';

function subscribe(listener: () => void): () => void {
  const observer = new MutationObserver(listener);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  return () => observer.disconnect();
}

/** A CSS color as a canvas takes it, resolving a `var(--name)` against the document. */
export function resolveColor(color: string): string {
  const match = /^var\((--[\w-]+)\)$/.exec(color.trim());

  if (match === null) {
    return color;
  }

  return getComputedStyle(document.documentElement).getPropertyValue(match[1]).trim() || color;
}

/**
 * CSS colors resolved for a canvas, rendering again when the document changes theme, once the
 * new theme applied.
 */
export function useResolvedColors(colors: readonly string[]): readonly string[] {
  const resolved = useSyncExternalStore(subscribe, () =>
    colors.map((color) => resolveColor(color)).join(SEPARATOR)
  );
  return resolved.split(SEPARATOR);
}
