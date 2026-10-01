/**
 * The keymap: every keyboard action of the app, the keys of the robot package's commands, their
 * default chords, and the user's overrides.
 *
 * @module
 */

import type { CommandSpec } from '@/robot-kit';
import type { Direction } from '@/tiling';

import { matchesChord, matchesChordHeld, parseChord, type Chord, type KeyInput } from './chords';

/** A workspace number a chord can name. */
export type WorkspaceDigit = '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9';

/** The action that sends a command of the robot package, by the command's name. */
export type CommandAction = `command.${string}`;

/** Something the keyboard can do. */
export type KeyAction =
  | `focus.${Direction}`
  | `swap.${Direction}`
  | `workspace.${WorkspaceDigit}`
  | `send-to-workspace.${WorkspaceDigit}`
  | 'workspace.move-left'
  | 'workspace.move-right'
  | 'workspace.close'
  | 'window.maximize'
  | 'window.float'
  | 'window.close'
  | 'window.pause'
  | 'launcher'
  | 'drawer'
  | CommandAction;

/** How a group of actions is titled in the keys legend. */
export type ActionGroup = 'Windows' | 'Workspaces' | 'Robot' | 'App';

/** An action of the keymap. */
export interface ActionSpec {
  readonly id: KeyAction;
  readonly label: string;
  readonly group: ActionGroup;
  readonly defaults: readonly string[];
  /** Whether it also acts while typing in a text field. */
  readonly inText: boolean;
  /** Whether its chords also match with more modifiers held, as a dangerous command's do. */
  readonly loose?: boolean;
}

/** The chords bound to each action. */
export type KeyBindings = ReadonlyMap<KeyAction, readonly Chord[]>;

/** Chords the user chose, by action, as they are stored. */
export type KeyOverrides = Readonly<Partial<Record<KeyAction, readonly string[]>>>;

const DIRECTIONS: readonly (readonly [Direction, string, string])[] = [
  ['left', 'ArrowLeft', 'left'],
  ['right', 'ArrowRight', 'right'],
  ['up', 'ArrowUp', 'up'],
  ['down', 'ArrowDown', 'down'],
];

const DIGITS: readonly WorkspaceDigit[] = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];

/** Every action, with the defaults of the chosen design. */
export const ACTIONS: readonly ActionSpec[] = [
  ...DIRECTIONS.map(([direction, key, word]): ActionSpec => ({
    id: `focus.${direction}`,
    label: `Focus the window ${word}`,
    group: 'Windows',
    defaults: [`Alt+${key}`],
    inText: true,
  })),
  ...DIRECTIONS.map(([direction, key, word]): ActionSpec => ({
    id: `swap.${direction}`,
    label: `Move the window ${word}`,
    group: 'Windows',
    defaults: [`Alt+Shift+${key}`],
    inText: true,
  })),
  { id: 'window.maximize', label: 'Maximize', group: 'Windows', defaults: ['Alt+F'], inText: true },
  { id: 'window.float', label: 'Float', group: 'Windows', defaults: ['Alt+O'], inText: true },
  { id: 'window.close', label: 'Close', group: 'Windows', defaults: ['Alt+Q'], inText: true },
  { id: 'window.pause', label: 'Pause', group: 'Windows', defaults: ['P'], inText: false },
  ...DIGITS.map((digit): ActionSpec => ({
    id: `workspace.${digit}`,
    label: `Go to workspace ${digit}`,
    group: 'Workspaces',
    defaults: [`Alt+${digit}`],
    inText: true,
  })),
  ...DIGITS.map((digit): ActionSpec => ({
    id: `send-to-workspace.${digit}`,
    label: `Send the window to workspace ${digit}`,
    group: 'Workspaces',
    defaults: [`Alt+Shift+${digit}`],
    inText: true,
  })),
  {
    id: 'workspace.move-left',
    label: 'Move the workspace left',
    group: 'Workspaces',
    defaults: ['Alt+Shift+PageUp'],
    inText: true,
  },
  {
    id: 'workspace.move-right',
    label: 'Move the workspace right',
    group: 'Workspaces',
    defaults: ['Alt+Shift+PageDown'],
    inText: true,
  },
  {
    id: 'workspace.close',
    label: 'Close the workspace',
    group: 'Workspaces',
    defaults: ['Alt+Shift+W'],
    inText: true,
  },
  { id: 'launcher', label: 'Launcher', group: 'App', defaults: ['Ctrl+K', 'Meta+K'], inText: true },
  { id: 'drawer', label: 'Variables', group: 'App', defaults: ['/'], inText: false },
];

const SPECS: ReadonlyMap<KeyAction, ActionSpec> = new Map(ACTIONS.map((spec) => [spec.id, spec]));
const COMMAND_PREFIX = 'command.';

/** The action that sends a command. */
export function commandAction(command: Pick<CommandSpec, 'name'>): CommandAction {
  return `${COMMAND_PREFIX}${command.name}`;
}

/** The name of the command an action sends, or null for an action of the app. */
export function commandOf(action: KeyAction): string | null {
  return action.startsWith(COMMAND_PREFIX) ? action.slice(COMMAND_PREFIX.length) : null;
}

/**
 * The actions of the commands that have a key: they act wherever the focus is but in a text
 * field, and a dangerous one's chords also match with more modifiers held.
 */
export function commandActions(commands: readonly CommandSpec[]): readonly ActionSpec[] {
  return commands.flatMap((command) =>
    command.key === undefined
      ? []
      : [
          {
            id: commandAction(command),
            label: command.label,
            group: 'Robot',
            defaults: [command.key],
            inText: false,
            loose: command.tone === 'danger',
          },
        ]
  );
}

/** The spec of an action; a command's when it is one. */
export function actionSpec(action: KeyAction): ActionSpec {
  const spec = SPECS.get(action);
  const command = commandOf(action);

  if (spec !== undefined) {
    return spec;
  }

  if (command !== null) {
    return { id: action, label: command, group: 'Robot', defaults: [], inText: false };
  }

  throw new Error(`"${action}" is not an action of the keymap`);
}

/**
 * The chords of every action and command key: the user's where they chose some, the defaults
 * elsewhere. Stored overrides that no longer parse, or name no action, are skipped, so a bad
 * entry only costs its own binding.
 *
 * @param overrides The chords the user chose, by action.
 * @param commands The robot package's commands; those with a key get an action.
 */
export function resolveBindings(
  overrides: KeyOverrides = {},
  commands: readonly CommandSpec[] = []
): KeyBindings {
  return new Map(
    [...ACTIONS, ...commandActions(commands)].map((spec) => {
      const chords = parseAll(overrides[spec.id]) ?? parseAll(spec.defaults) ?? [];
      return [
        spec.id,
        spec.loose === true ? chords.map((chord) => ({ ...chord, loose: true })) : chords,
      ];
    })
  );
}

function parseAll(texts: readonly string[] | undefined): readonly Chord[] | undefined {
  if (texts === undefined) {
    return undefined;
  }

  const chords = texts.flatMap((text) => {
    try {
      return [parseChord(text)];
    } catch {
      return [];
    }
  });
  return chords.length === texts.length ? chords : undefined;
}

/**
 * The action an event triggers, or null. When two actions share a chord, the first one wins. A
 * loose chord also matches with more modifiers held than it has, unless another action has
 * exactly that chord.
 */
export function actionFor(bindings: KeyBindings, event: KeyInput): KeyAction | null {
  for (const [action, chords] of bindings) {
    if (chords.some((chord) => matchesChord(chord, event))) {
      return action;
    }
  }

  for (const [action, chords] of bindings) {
    if (chords.some((chord) => chord.loose === true && matchesChordHeld(chord, event))) {
      return action;
    }
  }

  return null;
}

/** The workspace index, from 0, that a workspace action names. */
export function workspaceIndexOf(digit: WorkspaceDigit): number {
  return Number(digit) - 1;
}

/**
 * The action a key event triggers where it happened: while typing in a text field, only the
 * actions that allow it, so that Space, P and `/` type as usual there.
 */
export function actionForEvent(
  bindings: KeyBindings,
  event: KeyInput,
  inText: boolean
): KeyAction | null {
  const action = actionFor(bindings, event);
  return action !== null && inText && !actionSpec(action).inText ? null : action;
}

/** The action that shows a workspace, by its index from 0, or null past the ninth. */
export function workspaceAction(index: number): `workspace.${WorkspaceDigit}` | null {
  const digit = index >= 0 ? DIGITS.at(index) : undefined;
  return digit === undefined ? null : `workspace.${digit}`;
}
