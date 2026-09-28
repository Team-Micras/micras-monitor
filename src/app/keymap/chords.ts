/**
 * Key chords: a key with its modifiers, parsed from text such as `Alt+Shift+ArrowLeft`, matched
 * against keyboard events and formatted for display.
 *
 * @module
 */

/** A key with its modifiers. `key` is an uppercase letter, a digit, a symbol or a key name. */
export interface Chord {
  readonly ctrl: boolean;
  readonly alt: boolean;
  readonly shift: boolean;
  readonly meta: boolean;
  readonly key: string;
}

/** The parts of a keyboard event a chord is matched against. */
export type KeyInput = Pick<
  KeyboardEvent,
  'key' | 'code' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey'
>;

const MODIFIERS = ['Ctrl', 'Alt', 'Shift', 'Meta'] as const;
const MODIFIER_KEYS = new Set(['Control', 'Alt', 'AltGraph', 'Shift', 'Meta', 'OS']);
const KEY_LABELS: Readonly<Record<string, string>> = {
  ArrowLeft: '←',
  ArrowRight: '→',
  ArrowUp: '↑',
  ArrowDown: '↓',
  Escape: 'Esc',
};

/**
 * Parses a chord written as modifiers and a key joined by `+`, such as `Ctrl+K`, `/` or
 * `Alt+Shift+1`. Letters are case-insensitive; `Space` names the space bar.
 *
 * @throws {Error} When the text has no key, an unknown or repeated modifier.
 */
export function parseChord(text: string): Chord {
  const parts = text.split('+');
  const key = parts.pop() ?? '';

  if (key === '') {
    throw new Error(`"${text}" names no key`);
  }

  const modifiers = new Set<string>();

  for (const part of parts) {
    if (!MODIFIERS.some((modifier) => modifier === part) || modifiers.has(part)) {
      throw new Error(`"${text}" has an unknown or repeated modifier "${part}"`);
    }

    modifiers.add(part);
  }

  return {
    ctrl: modifiers.has('Ctrl'),
    alt: modifiers.has('Alt'),
    shift: modifiers.has('Shift'),
    meta: modifiers.has('Meta'),
    key: normalizeKey(key),
  };
}

function normalizeKey(key: string): string {
  if (key === ' ') {
    return 'Space';
  }

  return key.length === 1 ? key.toUpperCase() : key;
}

/**
 * The key an event stands for. A letter or digit is read from `key`; when Ctrl, Alt or Meta is
 * held and turned it into another character (Alt on macOS, Alt+Shift on digits) it is read from
 * the physical `code`; anything else is `key` itself, so a symbol typed with Shift stays that
 * symbol. Null for a modifier pressed alone.
 */
export function keyOf(event: KeyInput): string | null {
  if (MODIFIER_KEYS.has(event.key)) {
    return null;
  }

  if (/^[a-z0-9]$/i.test(event.key)) {
    return event.key.toUpperCase();
  }

  const chorded = event.ctrlKey || event.altKey || event.metaKey;
  const physical = chorded ? /^(?:Key([A-Z])|Digit([0-9]))$/.exec(event.code) : null;

  if (physical !== null) {
    return physical[1] ?? physical[2];
  }

  return normalizeKey(event.key);
}

function isSymbol(key: string): boolean {
  return key.length === 1 && !/[A-Z0-9]/.test(key);
}

/**
 * Tells whether an event is a chord. Modifiers must match exactly, except Shift on a symbol,
 * since layouts differ on whether `/` needs it.
 */
export function matchesChord(chord: Chord, event: KeyInput): boolean {
  const key = keyOf(event);
  return (
    key === chord.key &&
    event.ctrlKey === chord.ctrl &&
    event.altKey === chord.alt &&
    event.metaKey === chord.meta &&
    (isSymbol(chord.key) || event.shiftKey === chord.shift)
  );
}

/**
 * Tells whether an event is a chord with any other modifiers held too, as the emergency stop
 * matches: a Shift held by accident must not keep the robot from stopping.
 */
export function matchesChordHeld(chord: Chord, event: KeyInput): boolean {
  return (
    keyOf(event) === chord.key &&
    (!chord.ctrl || event.ctrlKey) &&
    (!chord.alt || event.altKey) &&
    (!chord.shift || event.shiftKey) &&
    (!chord.meta || event.metaKey)
  );
}

/** The keys of a chord as they are shown, one label per key cap, such as `['Alt', '←']`. */
export function formatChord(chord: Chord): readonly string[] {
  const modifiers = MODIFIERS.filter((modifier) => chord[modifierField(modifier)]);
  return [...modifiers, KEY_LABELS[chord.key] ?? chord.key];
}

const MODIFIER_FIELDS: Readonly<
  Record<(typeof MODIFIERS)[number], 'ctrl' | 'alt' | 'shift' | 'meta'>
> = { Ctrl: 'ctrl', Alt: 'alt', Shift: 'shift', Meta: 'meta' };

function modifierField(modifier: (typeof MODIFIERS)[number]): 'ctrl' | 'alt' | 'shift' | 'meta' {
  return MODIFIER_FIELDS[modifier];
}
