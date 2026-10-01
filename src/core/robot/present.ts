/**
 * How the generic UI reads a package: presentation of a variable, labels of values, roles and
 * commands. Every function accepts a null package, which is raw mode.
 *
 * @module
 */

import { isInteger, typeLabel, type Variable } from '../variables';

import type {
  BitFlag,
  BitmaskType,
  CommandSpec,
  EnumType,
  RobotPackage,
  Role,
  SerializableType,
} from './types';

/** How to show one variable, from its schema entry and what the package adds. */
export interface VariablePresentation<Node = unknown> {
  /**
   * The type as people read it: the serializable, enum or bitmask name, else the label of its
   * value type.
   */
  readonly typeLabel: string;
  readonly unit: string | null;
  readonly description: string | null;
  readonly color: string | null;
  /** Labels for an integer variable. */
  readonly labels: EnumType | BitmaskType | null;
  /** The type that decodes a blob. */
  readonly serializable: SerializableType<unknown, Node> | null;
}

/**
 * Presents a variable. Labels apply only to integer variables and serializable types only to
 * blobs, whatever the package says; a blob's type is found by the tag the schema carries, else by
 * the one the package names for the variable. A blob of no known type shows its tag.
 */
export function presentVariable<Node>(
  pkg: RobotPackage<Node> | null,
  variable: Variable
): VariablePresentation<Node> {
  const spec = pkg?.variables[variable.name];
  const blob = variable.type === 'bytes';
  const tag = blob ? (variable.tag ?? spec?.serializable ?? null) : null;
  const serializable = tag === null ? null : (pkg?.types.find((type) => type.tag === tag) ?? null);
  const labels = isInteger(variable.type) ? (spec?.labels ?? null) : null;
  return {
    typeLabel: serializable?.name ?? labels?.name ?? tag ?? typeLabel(variable.type),
    unit: spec?.unit ?? null,
    description: spec?.description ?? null,
    color: spec?.color ?? null,
    labels,
    serializable,
  };
}

/** The label of an enum value, or the number itself when the enum has no such value. */
export function enumLabel(type: EnumType, value: number): string {
  return type.options.find((option) => option.value === value)?.label ?? String(value);
}

/** Tells whether a bit of an integer is set; exact for every integer a `number` holds. */
export function hasBit(value: number, bit: number): boolean {
  return Math.floor(Math.abs(value) / 2 ** bit) % 2 === 1;
}

/** The flags of a bitmask that are set in a value, in the bitmask's order. */
export function activeFlags(type: BitmaskType, value: number): readonly BitFlag[] {
  return type.flags.filter((flag) => hasBit(value, flag.bit));
}

/** The name of the variable playing a role, or null. */
export function roleVariable(pkg: RobotPackage | null, role: Role): string | null {
  return pkg?.roles[role] ?? null;
}

/**
 * Tells whether the robot is expected to accept a command in a state, per the package's mirror
 * of the firmware table; null when the state is unknown.
 */
export function acceptedIn(command: CommandSpec, state: number | null): boolean | null {
  if (command.acceptedIn === 'any') {
    return true;
  }

  return state === null ? null : command.acceptedIn.includes(state);
}

/** Why the robot refused a command, in words, or null when the reason is none or unknown. */
export function refusalReason(pkg: RobotPackage | null, reason: number | null): string | null {
  return reason === null ? null : (pkg?.refusalReasons[reason] ?? null);
}

/**
 * Tells whether the robot is at rest in a state, by the package's `idleStates`, else by the state
 * role's enum label `IDLE` in any case; null when there is no package or no way to tell.
 */
export function isIdleState(pkg: RobotPackage | null, state: number): boolean | null {
  if (pkg?.idleStates !== undefined) {
    return pkg.idleStates.includes(state);
  }

  const stateName = roleVariable(pkg, 'state');
  const labels = stateName === null ? undefined : pkg?.variables[stateName]?.labels;

  if (labels?.kind !== 'enum') {
    return null;
  }

  const option = labels.options.find((entry) => entry.value === state);
  return option === undefined ? null : option.label.toLowerCase() === 'idle';
}
