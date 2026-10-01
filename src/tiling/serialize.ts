/**
 * JSON snapshots of a desktop, versioned, validated on the way back in, and migrated from older
 * versions.
 *
 * @module
 */

import { LayoutError } from './errors';
import type {
  Desktop,
  DockMemory,
  FloatingWindow,
  Orientation,
  Rect,
  Side,
  TileNode,
  TilingWindow,
  WindowId,
  Workspace,
} from './types';
import { firstRepeated, ORIENTATIONS, SIDES, validateDesktop } from './validate';

/** The snapshot format this engine writes. Bump it, and add a migration, when the shape changes. */
export const LAYOUT_VERSION = 1;

/** A window in a snapshot; the payload is whatever the caller's writer made of it. */
export interface WindowSnapshot {
  readonly id: string;
  readonly kind: string;
  readonly payload: unknown;
}

/** A rect in a snapshot. */
export interface RectSnapshot {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** A split tree node in a snapshot. */
export type NodeSnapshot =
  | { readonly type: 'leaf'; readonly id: string }
  | {
      readonly type: 'split';
      readonly orientation: Orientation;
      readonly ratio: number;
      readonly first: NodeSnapshot;
      readonly second: NodeSnapshot;
    };

/** Where a floating window was tiled, in a snapshot. */
export interface DockSnapshot {
  readonly siblings: readonly string[];
  readonly side: Side;
  readonly ratio: number;
}

/** A floating window in a snapshot. */
export interface FloatingSnapshot {
  readonly id: string;
  readonly rect: RectSnapshot;
  readonly dock: DockSnapshot | null;
}

/** A workspace in a snapshot. */
export interface WorkspaceSnapshot {
  readonly name: string;
  readonly root: NodeSnapshot | null;
  readonly floating: readonly FloatingSnapshot[];
  readonly focus: readonly string[];
  readonly maximized: string | null;
}

/** A desktop as plain, versioned data, ready for `JSON.stringify`. */
export interface DesktopSnapshot {
  readonly version: number;
  readonly active: number;
  readonly windows: readonly WindowSnapshot[];
  readonly workspaces: readonly WorkspaceSnapshot[];
}

/** Turns a snapshot of version `n` into one of version `n + 1`. */
export type Migration = (snapshot: Readonly<Record<string, unknown>>) => Record<string, unknown>;

/** The engine's own migrations, keyed by the version they upgrade from. */
export const LAYOUT_MIGRATIONS: Readonly<Record<number, Migration>> = {};

/** How to restore a snapshot. */
export interface RestoreOptions<P> {
  /**
   * Checks and converts a window's payload. It may throw; the error is reported against the
   * payload's path. Without a reader, payloads are restored as `unknown`, as they were written.
   */
  readonly readPayload: (value: unknown, path: string) => P;
  /** Migrations to apply, keyed by the version they upgrade from; the engine's by default. */
  readonly migrations?: Readonly<Record<number, Migration>>;
}

/**
 * Turns a desktop into a snapshot of the current version.
 *
 * @param writePayload Converts a payload to JSON-ready data; the payload itself by default.
 */
export function serializeDesktop<P>(
  desktop: Desktop<P>,
  writePayload: (payload: P) => unknown = (payload) => payload
): DesktopSnapshot {
  return {
    version: LAYOUT_VERSION,
    active: desktop.active,
    windows: [...desktop.windows.values()].map(({ id, kind, payload }) => ({
      id,
      kind,
      payload: writePayload(payload),
    })),
    workspaces: desktop.workspaces.map(writeWorkspace),
  };
}

function writeWorkspace(workspace: Workspace): WorkspaceSnapshot {
  return {
    name: workspace.name,
    root: workspace.root === null ? null : writeNode(workspace.root),
    floating: workspace.floating.map(writeFloating),
    focus: [...workspace.focus],
    maximized: workspace.maximized,
  };
}

function writeNode(node: TileNode): NodeSnapshot {
  if (node.type === 'leaf') {
    return { type: 'leaf', id: node.id };
  }

  return {
    type: 'split',
    orientation: node.orientation,
    ratio: node.ratio,
    first: writeNode(node.first),
    second: writeNode(node.second),
  };
}

function writeFloating({ id, rect, dock }: FloatingWindow): FloatingSnapshot {
  return {
    id,
    rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    dock:
      dock === null ? null : { siblings: [...dock.siblings], side: dock.side, ratio: dock.ratio },
  };
}

/**
 * Rebuilds a desktop from a parsed snapshot: migrates it to the current version, reads every
 * field and checks the result with `validateDesktop`.
 *
 * @throws {LayoutError} Naming the first field that is missing, has the wrong type or breaks a
 *   rule, or the version when it is unknown, has no migration or its migration fails.
 */
export function restoreDesktop(
  value: unknown,
  options?: Omit<RestoreOptions<unknown>, 'readPayload'>
): Desktop;
export function restoreDesktop<P>(value: unknown, options: RestoreOptions<P>): Desktop<P>;
export function restoreDesktop(
  value: unknown,
  options: Partial<RestoreOptions<unknown>> = {}
): Desktop {
  const snapshot = migrate(asRecord(value, 'snapshot'), options.migrations ?? LAYOUT_MIGRATIONS);
  const readPayload = options.readPayload ?? ((payload: unknown) => payload);
  const windows = asArray(snapshot.windows, 'windows').map((window, index) =>
    readWindow(window, `windows[${index}]`, readPayload)
  );
  const repeated = firstRepeated(windows.map((window) => window.id));

  if (repeated !== -1) {
    throw new LayoutError(`windows[${repeated}].id`, `repeats "${windows[repeated].id}"`);
  }

  const desktop: Desktop = {
    windows: new Map(windows.map((window) => [window.id, window])),
    workspaces: asArray(snapshot.workspaces, 'workspaces').map((workspace, index) =>
      readWorkspace(workspace, `workspaces[${index}]`)
    ),
    active: asNumber(snapshot.active, 'active'),
  };
  validateDesktop(desktop);
  return desktop;
}

function migrate(
  snapshot: Readonly<Record<string, unknown>>,
  migrations: Readonly<Record<number, Migration>>
): Readonly<Record<string, unknown>> {
  const { version } = snapshot;

  if (typeof version !== 'number' || !Number.isInteger(version)) {
    throw new LayoutError('version', 'must be an integer');
  }

  if (version > LAYOUT_VERSION) {
    throw new LayoutError(
      'version',
      `is ${version}, newer than ${LAYOUT_VERSION}, the latest known`
    );
  }

  if (version === LAYOUT_VERSION) {
    return snapshot;
  }

  const migration = migrations[version];

  if (migration === undefined) {
    throw new LayoutError('version', `is ${version}, which has no migration to ${version + 1}`);
  }

  return migrate({ ...upgrade(migration, snapshot, version), version: version + 1 }, migrations);
}

function upgrade(
  migration: Migration,
  snapshot: Readonly<Record<string, unknown>>,
  version: number
): Readonly<Record<string, unknown>> {
  let upgraded: unknown;

  try {
    upgraded = migration(snapshot);
  } catch (error) {
    if (error instanceof LayoutError) {
      throw error;
    }

    throw new LayoutError(
      'version',
      `is ${version}, and its migration to ${version + 1} failed: ${String(error)}`
    );
  }

  if (!isRecord(upgraded)) {
    throw new LayoutError(
      'version',
      `is ${version}, and its migration to ${version + 1} did not return an object`
    );
  }

  return upgraded;
}

function readWindow<P>(
  value: unknown,
  where: string,
  readPayload: (value: unknown, path: string) => P
): TilingWindow<P> {
  const window = asRecord(value, where);
  const id = asString(window.id, `${where}.id`);
  const kind = asString(window.kind, `${where}.kind`);
  return { id, kind, payload: readPayloadAt(window.payload, `${where}.payload`, readPayload) };
}

function readPayloadAt<P>(
  value: unknown,
  where: string,
  readPayload: (value: unknown, path: string) => P
): P {
  try {
    return readPayload(value, where);
  } catch (error) {
    if (error instanceof LayoutError) {
      throw error;
    }

    throw new LayoutError(where, `is not a valid payload: ${String(error)}`);
  }
}

function readWorkspace(value: unknown, where: string): Workspace {
  const workspace = asRecord(value, where);
  return {
    name: asString(workspace.name, `${where}.name`),
    root: workspace.root === null ? null : readNode(workspace.root, `${where}.root`),
    floating: asArray(workspace.floating, `${where}.floating`).map((entry, index) =>
      readFloating(entry, `${where}.floating[${index}]`)
    ),
    focus: readIds(workspace.focus, `${where}.focus`),
    maximized:
      workspace.maximized === null ? null : asString(workspace.maximized, `${where}.maximized`),
  };
}

function readNode(value: unknown, where: string): TileNode {
  const node = asRecord(value, where);

  if (node.type === 'leaf') {
    return { type: 'leaf', id: asString(node.id, `${where}.id`) };
  }

  if (node.type !== 'split') {
    throw new LayoutError(`${where}.type`, 'must be "leaf" or "split"');
  }

  return {
    type: 'split',
    orientation: asOneOf(node.orientation, ORIENTATIONS, `${where}.orientation`),
    ratio: asNumber(node.ratio, `${where}.ratio`),
    first: readNode(node.first, `${where}.first`),
    second: readNode(node.second, `${where}.second`),
  };
}

function readFloating(value: unknown, where: string): FloatingWindow {
  const entry = asRecord(value, where);
  return {
    id: asString(entry.id, `${where}.id`),
    rect: readRect(entry.rect, `${where}.rect`),
    dock: entry.dock === null ? null : readDock(entry.dock, `${where}.dock`),
  };
}

function readDock(value: unknown, where: string): DockMemory {
  const dock = asRecord(value, where);
  return {
    siblings: readIds(dock.siblings, `${where}.siblings`),
    side: asOneOf(dock.side, SIDES, `${where}.side`),
    ratio: asNumber(dock.ratio, `${where}.ratio`),
  };
}

function readRect(value: unknown, where: string): Rect {
  const rect = asRecord(value, where);
  return {
    x: asNumber(rect.x, `${where}.x`),
    y: asNumber(rect.y, `${where}.y`),
    width: asNumber(rect.width, `${where}.width`),
    height: asNumber(rect.height, `${where}.height`),
  };
}

function readIds(value: unknown, where: string): WindowId[] {
  return asArray(value, where).map((id, index) => asString(id, `${where}[${index}]`));
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown, where: string): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new LayoutError(where, 'must be an object');
  }

  return Object.fromEntries(Object.entries(value));
}

function asArray(value: unknown, where: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new LayoutError(where, 'must be an array');
  }

  return value;
}

function asString(value: unknown, where: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new LayoutError(where, 'must be a non-empty string');
  }

  return value;
}

function asNumber(value: unknown, where: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new LayoutError(where, 'must be a finite number');
  }

  return value;
}

function asOneOf<T extends string>(value: unknown, options: readonly T[], where: string): T {
  const match = options.find((option) => option === value);

  if (match === undefined) {
    throw new LayoutError(where, `must be one of ${options.map((o) => `"${o}"`).join(', ')}`);
  }

  return match;
}
