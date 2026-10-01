/**
 * What a robot's saved layouts are filed under: the package that draws it, else the name it
 * announced, else the names of its variables. Never the schema hash, which changes whenever
 * the firmware gains a variable.
 *
 * @module
 */

/** What identifies a connected robot for its layouts. */
export interface RobotIdentity {
  /** The id of the robot package chosen for it, or null in raw mode. */
  readonly packageId: string | null;
  /** The name HELLO_ACK announced, or null. */
  readonly name: string | null;
  /** The names of every variable of its schema. */
  readonly variables: readonly string[];
}

/** The prefix of the keys that stand for a set of variable names. */
export const SIGNATURE_PREFIX = 'signature:';

/** A stable signature of a set of names, the same for any order and repeats. */
export function nameSetSignature(names: readonly string[]): string {
  let hash = 0x811c9dc5;

  for (const name of [...new Set(names)].toSorted()) {
    for (const char of `${name}\n`) {
      hash = Math.imul(hash ^ (char.codePointAt(0) ?? 0), 0x01000193) >>> 0;
    }
  }

  return hash.toString(16).padStart(8, '0');
}

/**
 * The key of a robot's layouts: `name:<name>` when it announced one, else `package:<id>` when a
 * package was matched by its variables, else `signature:<hash>` of its variable names.
 */
export function layoutKey({ packageId, name, variables }: RobotIdentity): string {
  if (name !== null) {
    return `name:${name}`;
  }

  return packageId === null
    ? `${SIGNATURE_PREFIX}${nameSetSignature(variables)}`
    : `package:${packageId}`;
}

/** How much two sets of names overlap, from 0 to 1: the shared names over all the names. */
export function overlap(a: readonly string[], b: readonly string[]): number {
  const left = new Set(a);
  const right = new Set(b);
  const shared = [...left].filter((name) => right.has(name)).length;
  const all = left.size + right.size - shared;
  return all === 0 ? 1 : shared / all;
}
