/** The DOM id of a window's frame, which a splitter names in `aria-controls`. */
export function windowElementId(id: string): string {
  return `window-${id}`;
}
