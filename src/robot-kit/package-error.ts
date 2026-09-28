/**
 * Raised for a robot package the registry cannot accept. `path` names the offending field from
 * the package root, as in `commands[2].code`.
 */
export class PackageError extends Error {
  override readonly name = 'PackageError';

  /** The field at fault, in property-access notation from the package root. */
  readonly path: string;

  /**
   * @param packageId The package at fault.
   * @param path The field at fault.
   * @param problem What is wrong with it, phrased to follow the path.
   */
  constructor(packageId: string, path: string, problem: string) {
    super(`robot package "${packageId}": ${path} ${problem}`);
    this.path = path;
  }
}
