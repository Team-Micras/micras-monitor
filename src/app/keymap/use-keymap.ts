/**
 * The keyboard listener of the app, which turns key events into keymap actions.
 *
 * @module
 */

import { useEffect, useEffectEvent } from 'react';

import { actionForEvent, commandOf, type KeyAction, type KeyBindings } from './keymap';

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

/** Tells whether a key event types a character, Space aside, with no Ctrl, Alt or Meta held. */
export function typesCharacter(event: KeyboardEvent): boolean {
  return (
    event.key.length === 1 && event.key !== ' ' && !event.ctrlKey && !event.altKey && !event.metaKey
  );
}

/**
 * Listens to the keyboard for the whole window. It listens in the capture phase so that a
 * command's key is handled before anything else: its keydown and keyup are both swallowed, so the
 * same press never also presses a focused button, and a held key sends the command only once.
 * Space is swallowed the same way outside text fields even when no command has it, so it never
 * presses a button.
 *
 * @param bindings The chords of every action.
 * @param onAction Runs the action a key triggered.
 * @param onType Offered every key that types a character outside a text field before the
 *   keymap sees it; returning true claims the key, as the variables drawer does to send it to
 *   its search field.
 */
export function useKeymap(
  bindings: KeyBindings,
  onAction: (action: KeyAction) => void,
  onType?: (event: KeyboardEvent) => boolean
): void {
  const act = useEffectEvent(onAction);
  const type = useEffectEvent((event: KeyboardEvent) => onType?.(event) ?? false);

  useEffect(() => {
    const swallow = (event: KeyboardEvent, action: KeyAction | null, inText: boolean) => {
      if ((action !== null && commandOf(action) !== null) || (!inText && event.key === ' ')) {
        event.preventDefault();
        event.stopPropagation();
      }
    };

    const onKeyDown = (event: KeyboardEvent) => {
      const inText = isTextField(event.target);

      if (!inText && typesCharacter(event) && type(event)) {
        return;
      }

      const action = actionForEvent(bindings, event, inText);
      swallow(event, action, inText);

      if (action === null || (commandOf(action) !== null && event.repeat)) {
        return;
      }

      event.preventDefault();
      act(action);
    };

    const onKeyUp = (event: KeyboardEvent) => {
      const inText = isTextField(event.target);
      swallow(event, actionForEvent(bindings, event, inText), inText);
    };

    window.addEventListener('keydown', onKeyDown, { capture: true });
    window.addEventListener('keyup', onKeyUp, { capture: true });

    return () => {
      window.removeEventListener('keydown', onKeyDown, { capture: true });
      window.removeEventListener('keyup', onKeyUp, { capture: true });
    };
  }, [bindings]);
}
