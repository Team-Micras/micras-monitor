/**
 * The keyboard listener of the app, which turns key events into keymap actions.
 *
 * @module
 */

import { useEffect, useEffectEvent } from 'react';

import { actionForEvent, type KeyAction, type KeyBindings } from './keymap';

const TEXT_INPUT_TYPES = new Set([
  'text',
  'search',
  'url',
  'email',
  'password',
  'tel',
  'number',
  'date',
  'time',
  'datetime-local',
  'month',
  'week',
]);

/** Tells whether an event target takes typed text, where plain keys must type. */
export function isTextField(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  if (target instanceof HTMLInputElement) {
    return TEXT_INPUT_TYPES.has(target.type);
  }

  return (
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    target.isContentEditable
  );
}

/**
 * Listens to the keyboard for the whole window. It listens in the capture phase so that the
 * STOP key is handled before anything else: its keydown and keyup are both swallowed, so the
 * same press never also presses a focused button, and a held key stops only once.
 *
 * @param bindings The chords of every action.
 * @param onAction Runs the action a key triggered.
 */
export function useKeymap(bindings: KeyBindings, onAction: (action: KeyAction) => void): void {
  const act = useEffectEvent(onAction);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const action = actionForEvent(bindings, event, isTextField(event.target));

      if (action === null) {
        return;
      }

      event.preventDefault();

      if (action === 'stop') {
        event.stopPropagation();

        if (event.repeat) {
          return;
        }
      }

      act(action);
    };

    const onKeyUp = (event: KeyboardEvent) => {
      if (actionForEvent(bindings, event, isTextField(event.target)) === 'stop') {
        event.preventDefault();
        event.stopPropagation();
      }
    };

    window.addEventListener('keydown', onKeyDown, { capture: true });
    window.addEventListener('keyup', onKeyUp, { capture: true });

    return () => {
      window.removeEventListener('keydown', onKeyDown, { capture: true });
      window.removeEventListener('keyup', onKeyUp, { capture: true });
    };
  }, [bindings]);
}
