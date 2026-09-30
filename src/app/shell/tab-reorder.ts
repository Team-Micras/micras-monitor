/**
 * Reordering the workspace tabs by dragging one: which gap between the tabs the pointer is over,
 * and where the dragged tab ends up when it is dropped there.
 *
 * @module
 */

/**
 * The gap between tabs a pointer is over, from 0, before the first tab, to the number of tabs,
 * after the last: before the first tab whose middle lies right of the pointer.
 *
 * @param middles The horizontal middle of each tab, left to right, in client pixels.
 */
export function slotAt(middles: readonly number[], x: number): number {
  const index = middles.findIndex((middle) => x < middle);
  return index === -1 ? middles.length : index;
}

/**
 * The index a tab dragged from `from` takes when dropped in a gap, or null when that gap is on
 * either side of it, where dropping moves nothing.
 */
export function movedTo(from: number, slot: number): number | null {
  if (slot === from || slot === from + 1) {
    return null;
  }

  return slot > from ? slot - 1 : slot;
}
