import { describe, expect, test } from 'vitest';

import {
  chordId,
  formatChord,
  keyOf,
  matchesChord,
  matchesChordHeld,
  parseChord,
  type KeyInput,
} from '@/core/chords';

function press(key: string, modifiers: Partial<KeyInput> = {}, code = ''): KeyInput {
  return {
    key,
    code,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    metaKey: false,
    ...modifiers,
  };
}

describe('chordId', () => {
  test('is the same for chords that match the same events', () => {
    expect(chordId(parseChord('Alt+Shift+E'))).toBe(chordId(parseChord('Shift+Alt+E')));
    expect(chordId(parseChord('/'))).toBe(chordId(parseChord('Shift+/')));
    expect(chordId(parseChord('space'))).toBe(chordId(parseChord('Space')));
    expect(chordId(parseChord('Shift+E'))).not.toBe(chordId(parseChord('E')));
  });
});

describe('parseChord', () => {
  test('reads modifiers and a key', () => {
    expect(parseChord('Alt+Shift+ArrowLeft')).toEqual({
      ctrl: false,
      alt: true,
      shift: true,
      meta: false,
      key: 'ArrowLeft',
    });
  });

  test('uppercases letters and names the space bar', () => {
    expect(parseChord('ctrl+k'.replace('ctrl', 'Ctrl')).key).toBe('K');
    expect(parseChord(' ').key).toBe('Space');
    expect(parseChord('/').key).toBe('/');
  });

  test.each(['', 'Alt+', 'Hyper+K', 'Alt+Alt+K'])('rejects "%s"', (text) => {
    expect(() => parseChord(text)).toThrow(Error);
  });
});

describe('keyOf', () => {
  test('reads letters and digits from the key', () => {
    expect(keyOf(press('k'))).toBe('K');
    expect(keyOf(press('3'))).toBe('3');
  });

  test('falls back to the physical key when a modifier changed the character', () => {
    expect(keyOf(press('ƒ', { altKey: true }, 'KeyF'))).toBe('F');
    expect(keyOf(press('#', { altKey: true, shiftKey: true }, 'Digit3'))).toBe('3');
    expect(keyOf(press('#', { shiftKey: true }, 'Digit3'))).toBe('#');
  });

  test('names the space bar and ignores modifiers pressed alone', () => {
    expect(keyOf(press(' ', {}, 'Space'))).toBe('Space');
    expect(keyOf(press('Alt', { altKey: true }, 'AltLeft'))).toBeNull();
  });
});

describe('matchesChord', () => {
  test('needs the exact modifiers', () => {
    const chord = parseChord('Alt+F');
    expect(matchesChord(chord, press('f', { altKey: true }, 'KeyF'))).toBe(true);
    expect(matchesChord(chord, press('f', { altKey: true, shiftKey: true }, 'KeyF'))).toBe(false);
    expect(matchesChord(chord, press('f', {}, 'KeyF'))).toBe(false);
  });

  test('lets Shift vary on symbols, which layouts put on different levels', () => {
    expect(matchesChord(parseChord('/'), press('/', { shiftKey: true }, 'Digit7'))).toBe(true);
  });
});

test('matchesChordHeld needs the chord and takes more modifiers', () => {
  const chord = parseChord('Ctrl+Space');
  expect(matchesChordHeld(chord, press(' ', { ctrlKey: true, shiftKey: true }, 'Space'))).toBe(
    true
  );
  expect(matchesChordHeld(chord, press(' ', { shiftKey: true }, 'Space'))).toBe(false);
});

test('formatChord shows one label per key cap', () => {
  expect(formatChord(parseChord('Alt+Shift+ArrowUp'))).toEqual(['Alt', 'Shift', '↑']);
  expect(formatChord(parseChord('Ctrl+K'))).toEqual(['Ctrl', 'K']);
});
