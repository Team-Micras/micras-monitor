/**
 * The light and dark themes: which one to start with and how the choice is kept.
 *
 * @module
 */

/** A color theme. */
export type Theme = 'light' | 'dark';

const STORAGE_KEY = 'micras-monitor/theme';

/** The theme the user chose last, else the system's. */
export function initialTheme(): Theme {
  const stored = globalThis.localStorage?.getItem(STORAGE_KEY);

  if (stored === 'light' || stored === 'dark') {
    return stored;
  }

  return (globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false)
    ? 'dark'
    : 'light';
}

/** Shows a theme on the document and remembers it. */
export function applyTheme(theme: Theme): void {
  document.documentElement.classList.toggle('dark', theme === 'dark');
  globalThis.localStorage?.setItem(STORAGE_KEY, theme);
}
