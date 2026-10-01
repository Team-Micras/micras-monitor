import { describe, expect, test } from 'vitest';

import { chordId, parseChord, type KeyInput } from '@/core/chords';
import {
  ACTIONS,
  actionFor,
  appActionOf,
  actionForEvent,
  actionSpec,
  commandAction,
  commandKeyTaken,
  commandOf,
  reservedChord,
  resolveBindings,
  workspaceAction,
  workspaceIndexOf,
  type KeyOverrides,
} from '@/ui/keyboard/keymap';
import { tilingActionFor } from '@/ui/keyboard/tiling-actions';
import type { CommandSpec } from '@/core/robot';

const STOP: CommandSpec = {
  code: 5,
  name: 'STOP',
  label: 'Stop',
  acceptedIn: 'any',
  pinned: true,
  key: 'Space',
  tone: 'danger',
};
const GO: CommandSpec = { code: 0, name: 'GO', label: 'Go', acceptedIn: [0], key: 'G' };
const COMMANDS = [STOP, GO];

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

describe('appActionOf', () => {
  test('names the app action that has a chord by default, if any', () => {
    expect(appActionOf(parseChord('P'))).toBe('window.pause');
    expect(appActionOf(parseChord('Shift+/'))).toBe('drawer');
    expect(appActionOf(parseChord('Space'))).toBeNull();
  });

  test('is what a registry refuses to command keys', () => {
    expect(reservedChord(parseChord('/'))).toBe('the app (Variables)');
    expect(reservedChord(parseChord('Space'))).toBeNull();
  });
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
    expect(actionFor(bindings, press(' ', {}, 'Space'))).toBeNull();
    expect(actionFor(bindings, press('x'))).toBeNull();
  });

  test('binds the key of every command of the package that has one', () => {
    const bindings = resolveBindings({}, [...COMMANDS, { ...GO, name: 'KEYLESS', key: undefined }]);
    expect(bindings.size).toBe(ACTIONS.length + 2);
    expect(actionFor(bindings, press(' ', {}, 'Space'))).toBe('command.STOP');
    expect(actionFor(bindings, press('g', {}, 'KeyG'))).toBe('command.GO');
    expect(commandOf(commandAction(GO))).toBe('GO');
    expect(commandOf('launcher')).toBeNull();
  });

  test('takes the user overrides, for command keys as for the rest', () => {
    const bindings = resolveBindings({ 'command.STOP': ['Ctrl+Space'] }, COMMANDS);
    expect(actionFor(bindings, press(' ', {}, 'Space'))).toBeNull();
    expect(actionFor(bindings, press(' ', { ctrlKey: true }, 'Space'))).toBe('command.STOP');
  });

  test('sends a dangerous command with any modifier held, unless another action has that chord', () => {
    const bindings = resolveBindings({}, COMMANDS);
    expect(actionFor(bindings, press(' ', { shiftKey: true }, 'Space'))).toBe('command.STOP');
    expect(actionFor(bindings, press(' ', { ctrlKey: true, altKey: true }, 'Space'))).toBe(
      'command.STOP'
    );
    expect(actionFor(bindings, press('g', { ctrlKey: true }, 'KeyG'))).toBeNull();
    const quit: CommandSpec = { ...STOP, name: 'QUIT', label: 'Quit', key: 'Q' };
    const shared = resolveBindings({}, [quit]);
    expect(actionFor(shared, press('q', { altKey: true }, 'KeyQ'))).toBe('window.close');
    expect(actionFor(shared, press('q', { shiftKey: true }, 'KeyQ'))).toBe('command.QUIT');
  });

  test("keeps a command's key over an app override that takes it, and drops it from the app", () => {
    const bindings = resolveBindings(
      { drawer: ['G'], launcher: ['Space'], 'workspace.1': ['Shift+Space'] },
      COMMANDS
    );
    expect(actionFor(bindings, press('g', {}, 'KeyG'))).toBe('command.GO');
    expect(actionFor(bindings, press(' ', {}, 'Space'))).toBe('command.STOP');
    expect(actionFor(bindings, press(' ', { shiftKey: true }, 'Space'))).toBe('command.STOP');
    expect(bindings.get('drawer')).toEqual([]);
    expect(bindings.get('launcher')).toEqual([]);
    expect(bindings.get('workspace.1')).toEqual([]);
  });

  test.each([
    ['/', press('/'), 'drawer'],
    ['Ctrl+K', press('k', { ctrlKey: true }, 'KeyK'), 'launcher'],
    ['Alt+1', press('1', { altKey: true }, 'Digit1'), 'workspace.1'],
  ] as const)(
    "drops a command's override of %s, an app chord, for the package's key",
    (chord, event, app) => {
      const bindings = resolveBindings({ 'command.GO': [chord] }, COMMANDS);
      expect(actionFor(bindings, event)).toBe(app);
      expect(actionFor(bindings, press('g', {}, 'KeyG'))).toBe('command.GO');
    }
  );

  test('never binds one chord to a command and an action of the app', () => {
    const cases: KeyOverrides[] = [
      { drawer: ['G'], 'command.GO': ['/'] },
      { launcher: ['Space', 'Ctrl+K'], 'command.STOP': ['Ctrl+K'] },
      { 'command.GO': ['P'], 'window.pause': ['G'] },
      { 'workspace.2': ['Shift+Space'], 'command.GO': ['Alt+2'] },
    ];

    for (const overrides of cases) {
      const owners = new Map<string, Set<string>>();

      for (const [action, chords] of resolveBindings(overrides, COMMANDS)) {
        for (const chord of chords) {
          const side = commandOf(action) === null ? 'app' : 'command';
          owners.set(chordId(chord), (owners.get(chordId(chord)) ?? new Set()).add(side));
        }
      }

      expect([...owners.values()].every((sides) => sides.size === 1)).toBe(true);
    }
  });

  test('keeps the defaults of an override that no longer parses', () => {
    const bindings = resolveBindings({ drawer: ['Hyper+/'] });
    expect(actionFor(bindings, press('/'))).toBe('drawer');
  });
});

describe('commandKeyTaken', () => {
  test.each([
    ['/', '/ is already used by the app (Variables)'],
    ['Ctrl+K', 'Ctrl+K is already used by the app (Launcher)'],
    ['Alt+1', 'Alt+1 is already used by the app (Go to workspace 1)'],
  ])("refuses a command's override of %s, an app chord", (chord, reason) => {
    expect(commandKeyTaken({ 'command.GO': [chord] }, COMMANDS)).toBe(reason);
  });

  test("refuses an app override of a command's key, or of a chord STOP matches held", () => {
    expect(commandKeyTaken({ drawer: ['G'] }, COMMANDS)).toBe('G is already the key of Go');
    expect(commandKeyTaken({ 'window.pause': ['Shift+Space'] }, COMMANDS)).toBe(
      'Shift+Space is already the key of Stop'
    );
    expect(commandKeyTaken({ launcher: ['Ctrl+Alt+Space'] }, COMMANDS)).toBe(
      'Ctrl+Alt+Space is already the key of Stop'
    );
  });

  test("lets overrides that take no one else's chord through", () => {
    expect(commandKeyTaken({ 'command.GO': ['Alt+G'], drawer: ['Ctrl+B'] }, COMMANDS)).toBeNull();
    expect(
      commandKeyTaken({ 'command.STOP': ['Ctrl+Space'], drawer: ['Space'] }, COMMANDS)
    ).toBeNull();
  });
});

describe('actionForEvent', () => {
  const bindings = resolveBindings({}, COMMANDS);

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
    expect(actionForEvent(bindings, press(' ', {}, 'Space'), false)).toBe('command.STOP');
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
    expect(actionSpec('drawer')).toMatchObject({ group: 'App', inText: false });
    expect(actionSpec('command.GO')).toMatchObject({ group: 'Robot', inText: false });
  });
});

describe('tilingActionFor', () => {
  test('maps directions, workspaces and window actions', () => {
    expect(tilingActionFor('focus.up', 4)).toEqual({ type: 'focusDirection', direction: 'up' });
    expect(tilingActionFor('swap.left', 4)).toEqual({ type: 'swapDirection', direction: 'left' });
    expect(tilingActionFor('workspace.3', 4)).toEqual({ type: 'switchWorkspace', index: 2 });
    expect(tilingActionFor('send-to-workspace.2', 4)).toEqual({
      type: 'moveToWorkspace',
      index: 1,
      follow: false,
    });
    expect(tilingActionFor('window.maximize', 1)).toEqual({ type: 'toggleMaximize' });
    expect(tilingActionFor('window.float', 1)).toEqual({ type: 'toggleFloating' });
    expect(tilingActionFor('window.close', 1)).toEqual({ type: 'close' });
  });

  test('ignores workspaces that do not exist and actions outside the tiling', () => {
    expect(tilingActionFor('workspace.5', 4)).toBeNull();
    expect(tilingActionFor('send-to-workspace.9', 4)).toBeNull();
    expect(tilingActionFor('command.STOP', 4)).toBeNull();
    expect(tilingActionFor('launcher', 4)).toBeNull();
    expect(tilingActionFor('workspace.close', 4)).toBeNull();
  });

  test('moves the shown workspace a place, and nowhere past either end', () => {
    expect(tilingActionFor('workspace.move-left', 3, 1)).toEqual({
      type: 'moveWorkspace',
      from: 1,
      to: 0,
    });
    expect(tilingActionFor('workspace.move-right', 3, 1)).toEqual({
      type: 'moveWorkspace',
      from: 1,
      to: 2,
    });
    expect(tilingActionFor('workspace.move-left', 3, 0)).toBeNull();
    expect(tilingActionFor('workspace.move-right', 3, 2)).toBeNull();
  });
});
