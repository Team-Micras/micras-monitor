/**
 * Raised for a layout the engine cannot accept: a malformed snapshot, an inconsistent desktop or
 * a window id that is already taken. `path` names the offending field, as in
 * `workspaces[1].root.first.ratio`.
 */
export class LayoutError extends Error {
  override readonly name = 'LayoutError';

  /** The field at fault, in property-access notation from the desktop or snapshot root. */
  readonly path: string;

  /**
   * @param path The field at fault.
   * @param problem What is wrong with it, phrased to follow the path.
   */
  constructor(path: string, problem: string) {
    super(`${path} ${problem}`);
    this.path = path;
  }
}
