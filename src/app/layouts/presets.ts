/**
 * Layout presets as workspaces: building the windows and tiles a preset describes, describing a
 * workspace as a preset, and reading presets back from storage.
 *
 * @module
 */

import type { LayoutPreset, PresetNode } from '@/core/robot';
import {
  createDesktop,
  createWorkspace,
  leaf,
  split,
  type Desktop,
  type TileNode,
  type Workspace,
} from '@/tiling';

import type { ShellWindow, WindowPayload } from '../windows/types';

/** A workspace built from a preset and the windows it holds. */
export interface PresetWorkspace {
  readonly workspace: Workspace;
  readonly windows: readonly ShellWindow[];
}

/**
 * Builds the workspace a preset describes.
 *
 * @param newId Gives the id of a new window of a kind; it must never repeat one of the desktop
 *   the workspace goes into.
 */
export function presetWorkspace(
  preset: LayoutPreset,
  name: string,
  newId: (kind: string) => string
): PresetWorkspace {
  const windows: ShellWindow[] = [];

  const build = (node: PresetNode): TileNode => {
    if ('window' in node) {
      const { kind, title, variables = [] } = node.window;
      const id = newId(kind);
      windows.push({
        id,
        kind,
        payload: title === undefined ? { variables } : { title, variables },
      });
      return leaf(id);
    }

    return split(node.split, node.ratio, build(node.first), build(node.second));
  };

  const root = preset.root === null ? null : build(preset.root);
  return { workspace: createWorkspace(name, root), windows };
}

/**
 * The desktop that opens with a robot's presets: a workspace for each, in order.
 *
 * @param presets At least one.
 */
export function presetDesktop(presets: readonly LayoutPreset[]): Desktop<WindowPayload> {
  const counters = new Map<string, number>();
  const newId = (kind: string) => {
    const number = (counters.get(kind) ?? 0) + 1;
    counters.set(kind, number);
    return `${kind}-${number}`;
  };
  const built = presets.map((preset) => presetWorkspace(preset, preset.name, newId));
  return createDesktop(
    built.map(({ workspace }) => workspace),
    built.flatMap(({ windows }) => windows)
  );
}

function describe(node: TileNode, windows: ReadonlyMap<string, ShellWindow>): PresetNode | null {
  if (node.type === 'leaf') {
    const window = windows.get(node.id);

    if (window === undefined) {
      return null;
    }

    const { title, variables } = window.payload;
    return {
      window: {
        kind: window.kind,
        ...(title === undefined ? {} : { title }),
        ...(variables.length === 0 ? {} : { variables }),
      },
    };
  }

  const first = describe(node.first, windows);
  const second = describe(node.second, windows);

  if (first === null || second === null) {
    return first ?? second;
  }

  return { split: node.orientation, ratio: node.ratio, first, second };
}

/**
 * Describes the tiled windows of a workspace as a preset: their kinds, titles, variables and
 * the split tree. Floating windows, focus and maximizing are not part of a preset.
 */
export function workspacePreset(
  desktop: Desktop<WindowPayload>,
  index: number,
  name: string
): LayoutPreset {
  const { root } = desktop.workspaces[index];
  return { name, root: root === null ? null : describe(root, desktop.windows) };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readNode(value: unknown): PresetNode | null {
  if (!isRecord(value)) {
    return null;
  }

  if (isRecord(value.window)) {
    const { kind, title, variables } = value.window;

    if (
      typeof kind !== 'string' ||
      kind === '' ||
      (title !== undefined && typeof title !== 'string') ||
      (variables !== undefined &&
        !(Array.isArray(variables) && variables.every((name) => typeof name === 'string')))
    ) {
      return null;
    }

    return {
      window: {
        kind,
        ...(title === undefined ? {} : { title }),
        ...(variables === undefined ? {} : { variables }),
      },
    };
  }

  const { split: orientation, ratio } = value;
  const first = readNode(value.first);
  const second = readNode(value.second);

  if (
    (orientation !== 'row' && orientation !== 'column') ||
    typeof ratio !== 'number' ||
    !(ratio > 0 && ratio < 1) ||
    first === null ||
    second === null
  ) {
    return null;
  }

  return { split: orientation, ratio, first, second };
}

/**
 * The presets in a parsed value from storage. An entry that is malformed, or repeats the name of
 * an earlier one, is dropped and the others are kept.
 */
export function readPresets(value: unknown): LayoutPreset[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const presets: LayoutPreset[] = [];

  for (const entry of value) {
    if (!isRecord(entry) || typeof entry.name !== 'string' || entry.name === '') {
      continue;
    }

    const root = entry.root === null ? null : readNode(entry.root);
    const { name } = entry;

    if ((entry.root === null || root !== null) && !presets.some((preset) => preset.name === name)) {
      presets.push({ name, root });
    }
  }

  return presets;
}
