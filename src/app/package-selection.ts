/**
 * The robot package of the connected robot, chosen once per change of the connection or the
 * schema and kept while the link recovers.
 *
 * @module
 */

import type { ReactNode } from 'react';

import type { PackageSelection, RobotRegistry } from '@/robot-kit';

import type {
  ConnectionPort,
  ConnectionStatus,
  ConnectionTarget,
  RobotVariable,
  SchemaPort,
} from './ports';

interface Basis {
  readonly target: ConnectionTarget;
  readonly name: string | null;
  readonly variables: readonly RobotVariable[];
}

function sameTarget(a: ConnectionTarget, b: ConnectionTarget): boolean {
  if (a.transport === 'websocket') {
    return b.transport === 'websocket' && a.url === b.url;
  }

  return a.transport === b.transport;
}

/**
 * Chooses the package as soon as the robot said who it is and its schema is known, and keeps
 * that choice while the same connection reconfigures, reloads its schema or handshakes again,
 * so the top bar and STOP do not flicker. It lets go when the connection ends, fails, reaches
 * another target or another robot answers.
 */
export class PackageSelector {
  readonly #connection: ConnectionPort;
  readonly #schema: SchemaPort;
  readonly #robots: RobotRegistry<ReactNode>;
  readonly #listeners = new Set<() => void>();
  #selection: PackageSelection<ReactNode> | null = null;
  #basis: Basis | null = null;
  #unsubscribe: (() => void) | null = null;

  constructor(connection: ConnectionPort, schema: SchemaPort, robots: RobotRegistry<ReactNode>) {
    this.#connection = connection;
    this.#schema = schema;
    this.#robots = robots;
    this.#update();
  }

  /** The package chosen, or null for raw mode or no robot; the same object until it changes. */
  current(): PackageSelection<ReactNode> | null {
    if (this.#unsubscribe === null) {
      this.#update();
    }

    return this.#selection;
  }

  /** Calls `listener` after the choice changes; returns the function that stops it. */
  subscribe(listener: () => void): () => void {
    if (this.#listeners.size === 0) {
      const connection = this.#connection.subscribe(() => this.#update());
      const schema = this.#schema.subscribe(() => this.#update());
      this.#unsubscribe = () => {
        connection();
        schema();
      };
      this.#update();
    }

    this.#listeners.add(listener);

    return () => {
      this.#listeners.delete(listener);

      if (this.#listeners.size === 0) {
        this.#unsubscribe?.();
        this.#unsubscribe = null;
      }
    };
  }

  #update(): void {
    const next = this.#choose(this.#connection.status());

    if (next !== this.#selection) {
      this.#selection = next;
      [...this.#listeners].forEach((listener) => listener());
    }
  }

  #choose(status: ConnectionStatus): PackageSelection<ReactNode> | null {
    if (status.kind === 'disconnected' || status.kind === 'failed') {
      this.#basis = null;
      return null;
    }

    const basis = this.#basis;
    const kept = basis !== null && sameTarget(basis.target, status.target);

    if (status.kind !== 'linked') {
      return kept ? this.#selection : null;
    }

    const { name } = status.robot;

    if (status.phase === 'schema') {
      return kept && basis.name === name ? this.#selection : null;
    }

    const variables = this.#schema.variables();

    if (kept && basis.name === name && basis.variables === variables) {
      return this.#selection;
    }

    this.#basis = { target: status.target, name, variables };
    return this.#robots.select({ name, variables: variables.map((variable) => variable.name) });
  }
}
