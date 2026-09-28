/**
 * Contracts of robot packages, their registry and the helpers the generic UI reads them with.
 *
 * A package is plain data plus the functions that decode and draw serializable types. This layer
 * imports only the protocol's vocabulary and no framework; nothing in `src/` imports a package
 * except the composition root, which registers them.
 *
 * @module
 */

export type * from './types';
export { PackageError } from './package-error';
export { validatePackage } from './validate';
export {
  RobotRegistry,
  type PackageMatch,
  type PackageSelection,
  type RobotDescription,
} from './registry';
export {
  acceptedIn,
  activeFlags,
  emergencyCommand,
  enumLabel,
  hasBit,
  presentVariable,
  refusalReason,
  roleVariable,
  type VariablePresentation,
} from './present';
