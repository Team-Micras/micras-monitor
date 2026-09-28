/**
 * How the generic UI reads a package: presentation of a variable, labels of values, roles and
 * commands. Every function accepts a null package, which is raw mode.
 *
 * @module
 */

import { TypeCode, typeName } from '@/protocol';

import type {
  BitFlag,
  BitmaskType,
  CommandSpec,
  EnumType,
  RobotPackage,
  Role,
  SchemaVariable,
  SerializableType,
} from './types';

const INTEGER_TYPES: ReadonlySet<TypeCode> = new Set([
  TypeCode.U8,
  TypeCode.I8,
  TypeCode.U16,
  TypeCode.I16,
  TypeCode.U32,
  TypeCode.I32,
  TypeCode.U64,
  TypeCode.I64,
]);

/** How to show one variable, from its schema entry and what the package adds. */
export interface VariablePresentation<Node = unknown> {
  /** The type as people read it: the serializable, enum or bitmask name, else the wire type. */
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
  variable: SchemaVariable
): VariablePresentation<Node> {
  const spec = pkg?.variables[variable.name];
  const blob = variable.type === TypeCode.BLOB;
  const tag = blob ? (variable.typeTag ?? spec?.serializable ?? null) : null;
  const serializable = tag === null ? null : (pkg?.types.find((type) => type.tag === tag) ?? null);
  const labels = INTEGER_TYPES.has(variable.type) ? (spec?.labels ?? null) : null;
  return {
    typeLabel: serializable?.name ?? labels?.name ?? tag ?? typeName(variable.type),
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

/** The emergency stop command, or null when the package has none or there is no package. */
export function emergencyCommand(pkg: RobotPackage | null): CommandSpec | null {
  return pkg?.commands.find((command) => command.emergency === true) ?? null;
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
