/**
 * The registry of robot packages and the choice of the package for a connected robot.
 *
 * @module
 */

import { PackageError } from './package-error';
import type { RobotPackage } from './types';
import { validatePackage } from './validate';

/** What the monitor knows about a connected robot when it picks a package. */
export interface RobotDescription {
  /** The name HELLO_ACK announced, or null for firmware that does not announce one. */
  readonly name: string | null;
  /** The names of every variable of its schema. */
  readonly variables: readonly string[];
}

/** How a package was chosen: by the name the robot announced, or by its variables. */
export type PackageMatch = 'name' | 'variables';

/** The package chosen for a robot. */
export interface PackageSelection<Node = unknown> {
  readonly package: RobotPackage<Node>;
  readonly matchedBy: PackageMatch;
}

/** The robot packages the monitor was built with, by id. */
export class RobotRegistry<Node = unknown> {
  readonly #packages = new Map<string, RobotPackage<Node>>();

  /**
   * @param packages Packages to register, in order.
   * @throws {PackageError} As `register` does.
   */
  constructor(packages: Iterable<RobotPackage<Node>> = []) {
    for (const pkg of packages) {
      this.register(pkg);
    }
  }

  /**
   * Adds a package after checking it.
   *
   * @throws {PackageError} When the package is inconsistent or its id is already registered.
   */
  register(pkg: RobotPackage<Node>): void {
    validatePackage(pkg);

    if (this.#packages.has(pkg.id)) {
      throw new PackageError(pkg.id, 'id', 'is already registered');
    }

    this.#packages.set(pkg.id, pkg);
  }

  /** The package with this id, or undefined. */
  get(id: string): RobotPackage<Node> | undefined {
    return this.#packages.get(id);
  }

  /** Every package, in registration order. */
  list(): readonly RobotPackage<Node>[] {
    return [...this.#packages.values()];
  }

  /**
   * Picks the package for a robot. A robot that announces a name gets the package with that id or
   * none: a name is authoritative, so an unknown one means raw mode. A robot without a name gets
   * the package whose whole signature is in its schema; when several match, the longest signature
   * wins, and a tie between the longest means raw mode rather than a guess.
   *
   * @returns The chosen package, or null for raw mode.
   */
  select(robot: RobotDescription): PackageSelection<Node> | null {
    if (robot.name !== null) {
      const pkg = this.#packages.get(robot.name);
      return pkg === undefined ? null : { package: pkg, matchedBy: 'name' };
    }

    const names = new Set(robot.variables);
    const matches = this.list().filter(
      (pkg) => pkg.signature.length > 0 && pkg.signature.every((name) => names.has(name))
    );
    const longest = Math.max(0, ...matches.map((pkg) => pkg.signature.length));
    const best = matches.filter((pkg) => pkg.signature.length === longest);
    return best.length === 1 ? { package: best[0], matchedBy: 'variables' } : null;
  }
}
