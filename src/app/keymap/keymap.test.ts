import { describe, expect, test } from 'vitest';

import {
  formatChord,
  keyOf,
  matchesChord,
  matchesChordHeld,
  parseChord,
  type KeyInput,
} from './chords';
import {
  ACTIONS,
  actionFor,
  actionForEvent,
  actionSpec,
  resolveBindings,
  workspaceAction,
  workspaceIndexOf,
} from './keymap';
import { tilingCommandFor } from './tiling-commands';

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

describe('resolveBindings', () => {
  test('binds every action to its defaults', () => {
    const bindings = resolveBindings();
    expect(bindings.size).toBe(ACTIONS.length);
    expect(actionFor(bindings, press('ArrowRight', { altKey: true }, 'ArrowRight'))).toBe(
      'focus.right'
    );
    expect(actionFor(bindings, press('ArrowRight', { altKey: true, shiftKey: true }))).toBe(
      'swap.right'
    );
    expect(actionFor(bindings, press('2', { altKey: true }, 'Digit2'))).toBe('workspace.2');
    expect(actionFor(bindings, press('@', { altKey: true, shiftKey: true }, 'Digit2'))).toBe(
      'send-to-workspace.2'
    );
    expect(actionFor(bindings, press('k', { metaKey: true }, 'KeyK'))).toBe('launcher');
    expect(actionFor(bindings, press(' ', {}, 'Space'))).toBe('stop');
    expect(actionFor(bindings, press('x'))).toBeNull();
  });

  test('takes the user overrides', () => {
    const bindings = resolveBindings({ stop: ['Ctrl+Space'] });
    expect(actionFor(bindings, press(' ', {}, 'Space'))).toBeNull();
    expect(actionFor(bindings, press(' ', { ctrlKey: true }, 'Space'))).toBe('stop');
  });

  test('stops with any modifier held on Space, unless another action has that chord', () => {
    const bindings = resolveBindings();
    expect(actionFor(bindings, press(' ', { shiftKey: true }, 'Space'))).toBe('stop');
    expect(actionFor(bindings, press(' ', { ctrlKey: true, altKey: true }, 'Space'))).toBe('stop');
    const shared = resolveBindings({ launcher: ['Ctrl+Space'] });
    expect(actionFor(shared, press(' ', { ctrlKey: true }, 'Space'))).toBe('launcher');
    expect(actionFor(shared, press(' ', { shiftKey: true }, 'Space'))).toBe('stop');
  });

  test('keeps the defaults of an override that no longer parses', () => {
    const bindings = resolveBindings({ drawer: ['Hyper+/'] });
    expect(actionFor(bindings, press('/'))).toBe('drawer');
  });
});

describe('actionForEvent', () => {
  const bindings = resolveBindings();

  test('ignores Space, P and / while typing', () => {
    expect(actionForEvent(bindings, press(' ', {}, 'Space'), true)).toBeNull();
    expect(actionForEvent(bindings, press('p', {}, 'KeyP'), true)).toBeNull();
    expect(actionForEvent(bindings, press('/'), true)).toBeNull();
  });

  test('keeps the chords with modifiers while typing', () => {
    expect(actionForEvent(bindings, press('k', { ctrlKey: true }, 'KeyK'), true)).toBe('launcher');
    expect(actionForEvent(bindings, press('q', { altKey: true }, 'KeyQ'), true)).toBe(
      'window.close'
    );
  });

  test('acts on plain keys outside of text fields', () => {
    expect(actionForEvent(bindings, press(' ', {}, 'Space'), false)).toBe('stop');
    expect(actionForEvent(bindings, press('p', {}, 'KeyP'), false)).toBe('window.pause');
  });
});

describe('workspace actions', () => {
  test('number workspaces from one', () => {
    expect(workspaceAction(0)).toBe('workspace.1');
    expect(workspaceAction(8)).toBe('workspace.9');
    expect(workspaceAction(9)).toBeNull();
    expect(workspaceAction(-1)).toBeNull();
    expect(workspaceIndexOf('4')).toBe(3);
  });

  test('actionSpec describes an action', () => {
    expect(actionSpec('stop')).toMatchObject({ group: 'Robot', inText: false });
  });
});

describe('tilingCommandFor', () => {
  test('maps directions, workspaces and window actions', () => {
    expect(tilingCommandFor('focus.up', 4)).toEqual({ type: 'focusDirection', direction: 'up' });
    expect(tilingCommandFor('swap.left', 4)).toEqual({ type: 'swapDirection', direction: 'left' });
    expect(tilingCommandFor('workspace.3', 4)).toEqual({ type: 'switchWorkspace', index: 2 });
    expect(tilingCommandFor('send-to-workspace.2', 4)).toEqual({
      type: 'moveToWorkspace',
      index: 1,
      follow: false,
    });
    expect(tilingCommandFor('window.maximize', 1)).toEqual({ type: 'toggleMaximize' });
    expect(tilingCommandFor('window.float', 1)).toEqual({ type: 'toggleFloating' });
    expect(tilingCommandFor('window.close', 1)).toEqual({ type: 'close' });
  });

  test('ignores workspaces that do not exist and actions outside the tiling', () => {
    expect(tilingCommandFor('workspace.5', 4)).toBeNull();
    expect(tilingCommandFor('send-to-workspace.9', 4)).toBeNull();
    expect(tilingCommandFor('stop', 4)).toBeNull();
    expect(tilingCommandFor('launcher', 4)).toBeNull();
  });
});
