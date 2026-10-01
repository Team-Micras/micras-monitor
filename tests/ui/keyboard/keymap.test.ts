import { describe, expect, test } from 'vitest';

import { parseChord, type KeyInput } from '@/core/chords';
import {
  ACTIONS,
  actionFor,
  appActionOf,
  actionForEvent,
  actionSpec,
  commandAction,
  commandOf,
  reservedChord,
  resolveBindings,
  workspaceAction,
  workspaceIndexOf,
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
    const shared = resolveBindings({ launcher: ['Ctrl+Space'] }, COMMANDS);
    expect(actionFor(shared, press(' ', { ctrlKey: true }, 'Space'))).toBe('launcher');
    expect(actionFor(shared, press(' ', { shiftKey: true }, 'Space'))).toBe('command.STOP');
  });

  test("gives a command's chord to the command over an action of the app rebound to it", () => {
    const bindings = resolveBindings({ 'window.pause': ['Space'], launcher: ['G'] }, COMMANDS);
    expect(actionFor(bindings, press(' ', {}, 'Space'))).toBe('command.STOP');
    expect(actionFor(bindings, press(' ', { shiftKey: true }, 'Space'))).toBe('command.STOP');
    expect(actionFor(bindings, press('g', {}, 'KeyG'))).toBe('command.GO');
  });

  test('keeps the defaults of an override that no longer parses', () => {
    const bindings = resolveBindings({ drawer: ['Hyper+/'] });
    expect(actionFor(bindings, press('/'))).toBe('drawer');
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
