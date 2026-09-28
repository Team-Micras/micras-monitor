/**
 * How the keys the user rebound are kept between visits.
 *
 * @module
 */

import type { KeyOverrides } from '../keymap/keymap';

const STORAGE_KEY = 'micras-monitor/keymap';

function isChordList(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((chord) => typeof chord === 'string');
}

/**
 * The keys the user rebound last, or none. Entries that are not lists of chords are dropped;
 * chords that no longer parse are left for the keymap, which skips them.
 */
export function initialKeyOverrides(): KeyOverrides {
  const stored = globalThis.localStorage?.getItem(STORAGE_KEY);

  if (stored === null || stored === undefined) {
    return {};
  }

  try {
    const parsed: unknown = JSON.parse(stored);

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return {};
    }

    return Object.fromEntries(Object.entries(parsed).filter(([, chords]) => isChordList(chords)));
  } catch {
    return {};
  }
}

/** Remembers the keys the user rebound, forgetting them when none are. */
export function saveKeyOverrides(overrides: KeyOverrides): void {
  if (Object.keys(overrides).length === 0) {
    globalThis.localStorage?.removeItem(STORAGE_KEY);
  } else {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(overrides));
  }
}
