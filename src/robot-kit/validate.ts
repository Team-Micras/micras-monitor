/**
 * Consistency checks of a robot package, run when it is registered so that a broken package
 * fails at startup rather than when a robot connects.
 *
 * @module
 */

import { PackageError } from './package-error';
import type { BitmaskType, EnumType, PresetNode, RobotPackage } from './types';

const MAX_BIT = 52;

/**
 * Checks a package's internal consistency: a non-empty id, unique command codes and names, at
 * most one emergency command, unique enum values and bits, unique type tags, variables that name
 * known types, and presets whose ratios lie strictly inside (0, 1).
 *
 * @throws {PackageError} Naming the first field that breaks a rule.
 */
export function validatePackage(pkg: RobotPackage): void {
  const fail = (path: string, problem: string): never => {
    throw new PackageError(pkg.id, path, problem);
  };

  if (pkg.id === '') {
    fail('id', 'must be a non-empty string');
  }

  checkCommands(pkg, fail);
  checkTypes(pkg, fail);
  checkVariables(pkg, fail);
  checkIdleStates(pkg, fail);
  checkPresets(pkg, fail);
}

type Fail = (path: string, problem: string) => never;

function checkCommands(pkg: RobotPackage, fail: Fail): void {
  const codes = new Set<number>();
  const names = new Set<string>();
  let emergency: number | null = null;

  pkg.commands.forEach((command, index) => {
    const path = `commands[${index}]`;

    if (!Number.isInteger(command.code) || command.code < 0 || command.code > 255) {
      fail(`${path}.code`, 'must be an integer from 0 to 255');
    }

    if (codes.has(command.code)) {
      fail(`${path}.code`, `repeats ${command.code}`);
    }

    if (names.has(command.name)) {
      fail(`${path}.name`, `repeats "${command.name}"`);
    }

    if (command.emergency === true) {
      if (emergency !== null) {
        fail(`${path}.emergency`, `is already set on commands[${emergency}]`);
      }

      emergency = index;
    }

    if (command.argument?.options !== undefined) {
      checkEnum(command.argument.options, `${path}.argument.options`, fail);
    }

    codes.add(command.code);
    names.add(command.name);
  });
}

function checkTypes(pkg: RobotPackage, fail: Fail): void {
  const tags = new Set<string>();

  pkg.types.forEach((type, index) => {
    if (type.tag === '') {
      fail(`types[${index}].tag`, 'must be a non-empty string');
    }

    if (tags.has(type.tag)) {
      fail(`types[${index}].tag`, `repeats "${type.tag}"`);
    }

    tags.add(type.tag);
  });
}

function checkVariables(pkg: RobotPackage, fail: Fail): void {
  const tags = new Set(pkg.types.map((type) => type.tag));

  for (const [name, spec] of Object.entries(pkg.variables)) {
    const path = `variables["${name}"]`;

    if (spec.serializable !== undefined && !tags.has(spec.serializable)) {
      fail(`${path}.serializable`, `names no type of the package ("${spec.serializable}")`);
    }

    if (spec.labels?.kind === 'enum') {
      checkEnum(spec.labels, `${path}.labels`, fail);
    } else if (spec.labels?.kind === 'bitmask') {
      checkBitmask(spec.labels, `${path}.labels`, fail);
    }
  }
}

function checkIdleStates(pkg: RobotPackage, fail: Fail): void {
  pkg.idleStates?.forEach((state, index) => {
    if (!Number.isInteger(state)) {
      fail(`idleStates[${index}]`, 'must be an integer');
    }
  });
}

function checkEnum(type: EnumType, path: string, fail: Fail): void {
  const values = new Set<number>();

  type.options.forEach((option, index) => {
    if (!Number.isInteger(option.value)) {
      fail(`${path}.options[${index}].value`, 'must be an integer');
    }

    if (values.has(option.value)) {
      fail(`${path}.options[${index}].value`, `repeats ${option.value}`);
    }

    values.add(option.value);
  });
}

function checkBitmask(type: BitmaskType, path: string, fail: Fail): void {
  const bits = new Set<number>();

  type.flags.forEach((flag, index) => {
    if (!Number.isInteger(flag.bit) || flag.bit < 0 || flag.bit > MAX_BIT) {
      fail(`${path}.flags[${index}].bit`, `must be an integer from 0 to ${MAX_BIT}`);
    }

    if (bits.has(flag.bit)) {
      fail(`${path}.flags[${index}].bit`, `repeats ${flag.bit}`);
    }

    bits.add(flag.bit);
  });
}

function checkPresets(pkg: RobotPackage, fail: Fail): void {
  const names = new Set<string>();

  pkg.presets.forEach((preset, index) => {
    const path = `presets[${index}]`;

    if (preset.name === '') {
      fail(`${path}.name`, 'must be a non-empty string');
    }

    if (names.has(preset.name)) {
      fail(`${path}.name`, `repeats "${preset.name}"`);
    }

    names.add(preset.name);

    if (preset.root !== null) {
      checkNode(preset.root, `${path}.root`, fail);
    }
  });
}

function checkNode(node: PresetNode, path: string, fail: Fail): void {
  if ('window' in node) {
    if (node.window.kind === '') {
      fail(`${path}.window.kind`, 'must be a non-empty string');
    }

    return;
  }

  if (!(node.ratio > 0 && node.ratio < 1)) {
    fail(`${path}.ratio`, 'must lie strictly between 0 and 1');
  }

  checkNode(node.first, `${path}.first`, fail);
  checkNode(node.second, `${path}.second`, fail);
}
