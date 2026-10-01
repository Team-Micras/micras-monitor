/**
 * The monitor's own model of a robot's variables: their types, what may be done with them, and
 * the values they hold. It knows no wire format; a source maps its own codes onto it.
 *
 * @module
 */

/** The type of a variable's values. `bytes` is an opaque blob, such as a serialized maze. */
export type ValueType =
  | 'bool'
  | 'u8'
  | 'i8'
  | 'u16'
  | 'i16'
  | 'u32'
  | 'i32'
  | 'u64'
  | 'i64'
  | 'f32'
  | 'f64'
  | 'bytes';

/** What is true of every value of a type. */
export interface ValueTypeFacts {
  /** The name people read, such as `u8`; a `bytes` variable shows as `blob`. */
  readonly label: string;

  /** How many bytes one value takes; zero for `bytes`, which has no fixed size. */
  readonly size: number;

  /** Whether it holds whole numbers, `bool` excluded. */
  readonly integer: boolean;

  /** Whether it holds negative numbers. */
  readonly signed: boolean;

  /** Whether it holds floating point numbers. */
  readonly float: boolean;

  /** Whether it holds integers past 2⁵³, which a `number` cannot hold exactly, so a bigint does. */
  readonly wide: boolean;

  /** The smallest and largest value of an integer type, or null for the others. */
  readonly range: readonly [min: bigint, max: bigint] | null;
}

function integerFacts(bits: 8 | 16 | 32 | 64, signed: boolean): ValueTypeFacts {
  const range: readonly [bigint, bigint] = signed
    ? [-(2n ** BigInt(bits - 1)), 2n ** BigInt(bits - 1) - 1n]
    : [0n, 2n ** BigInt(bits) - 1n];

  return {
    label: `${signed ? 'i' : 'u'}${bits}`,
    size: bits / 8,
    integer: true,
    signed,
    float: false,
    wide: bits === 64,
    range,
  };
}

function floatFacts(bits: 32 | 64): ValueTypeFacts {
  return {
    label: `f${bits}`,
    size: bits / 8,
    integer: false,
    signed: true,
    float: true,
    wide: false,
    range: null,
  };
}

/** The facts of every type. */
export const VALUE_TYPES: Readonly<Record<ValueType, ValueTypeFacts>> = {
  bool: {
    label: 'bool',
    size: 1,
    integer: false,
    signed: false,
    float: false,
    wide: false,
    range: null,
  },
  u8: integerFacts(8, false),
  i8: integerFacts(8, true),
  u16: integerFacts(16, false),
  i16: integerFacts(16, true),
  u32: integerFacts(32, false),
  i32: integerFacts(32, true),
  u64: integerFacts(64, false),
  i64: integerFacts(64, true),
  f32: floatFacts(32),
  f64: floatFacts(64),
  bytes: {
    label: 'blob',
    size: 0,
    integer: false,
    signed: false,
    float: false,
    wide: false,
    range: null,
  },
};

/** Tells whether something is the name of a type, as a file or a cache spells it. */
export function isValueType(value: unknown): value is ValueType {
  return typeof value === 'string' && Object.hasOwn(VALUE_TYPES, value);
}

/** Tells whether a type holds whole numbers, `bool` excluded. */
export function isInteger(type: ValueType): boolean {
  return VALUE_TYPES[type].integer;
}

/** Tells whether a type holds floating point numbers. */
export function isFloat(type: ValueType): boolean {
  return VALUE_TYPES[type].float;
}

/** Tells whether a type holds integers a `number` cannot hold exactly, so its values are bigints. */
export function isWide(type: ValueType): boolean {
  return VALUE_TYPES[type].wide;
}

/** The name to show for a type. */
export function typeLabel(type: ValueType): string {
  return VALUE_TYPES[type].label;
}

/** What may be done with a variable. Every variable can be read on request. */
export interface Access {
  /** It may be part of a stream. */
  readonly stream: boolean;

  /** It may be written from outside the robot. */
  readonly write: boolean;

  /** Writes are taken only while the robot is stopped; meaningless without `write`. */
  readonly writeNeedsIdle: boolean;

  /** It is kept in the robot's flash, so it survives a reboot. */
  readonly persists: boolean;
}

/** A variable of the robot. */
export interface Variable {
  /** How the source names it while this schema lasts; ids change between firmware builds. */
  readonly id: number;

  /** Its name, which history and layouts are keyed by. */
  readonly name: string;

  /** The type of its values. */
  readonly type: ValueType;

  /** What may be done with it. */
  readonly access: Access;

  /** How the bytes of a `bytes` variable are to be read, such as `maze-grid`. */
  readonly tag?: string;
}

/** A value of a variable: a number, a boolean, a bigint for the wide integers, bytes for a blob. */
export type Value = number | bigint | boolean | Uint8Array;
