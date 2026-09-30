/** Selects what Tab can reach, before checking that it is on screen. */
export const TABBABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Keeps Tab and Shift+Tab inside a panel: past its last control the focus goes to its first,
 * and back from the first to the last. Call it from the panel's keydown.
 */
export function trapTab(event: KeyboardEvent, panel: HTMLElement): void {
  if (event.key !== 'Tab') {
    return;
  }

  const controls = [...panel.querySelectorAll<HTMLElement>(TABBABLE)];
  const first = controls.at(0);
  const last = controls.at(-1);

  if (first === undefined || last === undefined) {
    event.preventDefault();
    return;
  }

  const from = document.activeElement;
  const leaving = event.shiftKey ? from === first || from === panel : from === last;

  if (leaving) {
    event.preventDefault();
    (event.shiftKey ? last : first).focus();
  }
}
