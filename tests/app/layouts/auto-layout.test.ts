import { describe, expect, test } from 'vitest';

import type { ValueType, Variable } from '@/core/variables';
import { leafIds, windowIds } from '@/tiling';

import {
  autoLayout,
  MAX_DATA_WORKSPACES,
  MAX_EDITOR_VARIABLES,
  MAX_PLOT_VARIABLES,
  MAX_READOUT_VARIABLES,
  MAX_WINDOWS_PER_WORKSPACE,
} from '@/app/layouts/auto-layout';

const STREAM = { stream: true, write: false, writeNeedsIdle: false, persists: false };
const STREAM_WRITE = { stream: true, write: true, writeNeedsIdle: false, persists: false };
const PERSIST = { stream: false, write: false, writeNeedsIdle: false, persists: true };
const NONE = { stream: false, write: false, writeNeedsIdle: false, persists: false };

let nextId = 0;

function variable(name: string, type: ValueType = 'f32', access = STREAM): Variable {
  nextId += 1;
  return { id: nextId, name, type, access };
}

function series(
  prefix: string,
  count: number,
  type: ValueType = 'f32',
  access = STREAM
): Variable[] {
  return Array.from({ length: count }, (_, index) => variable(`${prefix}/v${index}`, type, access));
}

function summary(variables: readonly Variable[]) {
  const desktop = autoLayout(variables);
  return desktop.workspaces.map((workspace) => ({
    name: workspace.name,
    windows: windowIds(workspace).map((id) => {
      const window = desktop.windows.get(id);
      return `${window?.kind}:${window?.payload.title ?? ''}:${window?.payload.variables.join(',')}`;
    }),
  }));
}

describe('the automatic layout', () => {
  test('opens with an Overview of the link and the log, whatever the schema', () => {
    const desktop = autoLayout([]);
    expect(desktop.workspaces.map((workspace) => workspace.name)).toEqual(['Overview']);
    expect([...desktop.windows.values()].map((window) => window.kind)).toEqual(['link', 'log']);
    expect(desktop.active).toBe(0);
  });

  test('groups variables by the prefix of their names, one kind of window for each sort', () => {
    const layout = summary([
      variable('pose/x'),
      variable('pose/y'),
      variable('pose/steps', 'u32'),
      variable('gain', 'f32', STREAM_WRITE),
      variable('maze', 'bytes', PERSIST),
      variable('state', 'u8'),
    ]);
    expect(layout).toEqual([
      { name: 'Overview', windows: ['link::', 'log::'] },
      { name: 'Pose', windows: ['plot:Pose:pose/x,pose/y', 'readouts::pose/steps'] },
      {
        name: 'General',
        windows: ['plot:General:gain', 'readouts::state', 'editor::gain', 'type-view:maze:maze'],
      },
    ]);
  });

  test('puts the variables without a prefix in General, and a blob in a type view of its own', () => {
    const layout = summary([
      variable('state', 'u8'),
      variable('battery', 'f32'),
      variable('objective', 'u8', STREAM_WRITE),
      variable('maze', 'bytes', PERSIST),
    ]);
    expect(layout[1]).toEqual({
      name: 'General',
      windows: [
        'plot:General:battery',
        'readouts::state',
        'editor::objective',
        'type-view:maze:maze',
      ],
    });
  });

  test('leaves out what cannot be shown live and cannot be written', () => {
    const layout = summary([
      variable('cal/scale', 'f32', NONE),
      variable('cal/valid', 'bool', PERSIST),
    ]);
    expect(layout).toHaveLength(1);
  });

  test('splits a long group into plots, readouts and editors of a few variables', () => {
    const variables = [
      ...series('wall', MAX_PLOT_VARIABLES + 1),
      ...series('count', MAX_READOUT_VARIABLES + 1, 'u32'),
    ];
    const windows = autoLayout(variables).windows;
    const kinds = [...windows.values()].map((window) => [
      window.kind,
      window.payload.variables.length,
    ]);
    expect(kinds).toContainEqual(['plot', MAX_PLOT_VARIABLES]);
    expect(kinds).toContainEqual(['plot', 1]);
    expect(kinds).toContainEqual(['readouts', MAX_READOUT_VARIABLES]);
    expect(kinds).toContainEqual(['readouts', 1]);

    const editors = [
      ...autoLayout(series('cfg', MAX_EDITOR_VARIABLES + 1, 'f32', STREAM_WRITE)).windows.values(),
    ]
      .filter((window) => window.kind === 'editor')
      .map((window) => window.payload.variables.length);
    expect(editors).toEqual([MAX_EDITOR_VARIABLES, 1]);
  });

  test('titles the second plot of a group with its number', () => {
    const titles = [...autoLayout(series('wall', MAX_PLOT_VARIABLES + 1)).windows.values()]
      .filter((window) => window.kind === 'plot')
      .map((window) => window.payload.title);
    expect(titles).toEqual(['Wall', 'Wall 2']);
  });

  test('caps the windows of a workspace and starts a new one for a group that does not fit', () => {
    const variables = [
      ...series('a', 3 * MAX_PLOT_VARIABLES),
      ...series('b', 2 * MAX_PLOT_VARIABLES),
      ...series('c', MAX_PLOT_VARIABLES),
    ];
    const desktop = autoLayout(variables);
    const counts = desktop.workspaces.map((workspace) => leafIds(workspace.root).length);
    expect(Math.max(...counts)).toBeLessThanOrEqual(MAX_WINDOWS_PER_WORKSPACE);
    expect(desktop.workspaces.map((workspace) => workspace.name)).toEqual([
      'Overview',
      'A',
      'B +1',
    ]);
    expect(counts).toEqual([2, 3, 3]);
  });

  test('lets a group larger than a workspace spill over, with names that do not repeat', () => {
    const desktop = autoLayout(series('big', MAX_PLOT_VARIABLES * (MAX_WINDOWS_PER_WORKSPACE + 1)));
    expect(desktop.workspaces.map((workspace) => workspace.name)).toEqual([
      'Overview',
      'Big',
      'Big 2',
    ]);
    expect(desktop.workspaces.map((workspace) => leafIds(workspace.root).length)).toEqual([
      2, 4, 1,
    ]);
  });

  test('makes a bounded number of workspaces however large the schema', () => {
    const many = Array.from({ length: 40 }, (_, index) => series(`group${index}`, 2)).flat();
    const desktop = autoLayout(many);
    expect(desktop.workspaces).toHaveLength(1 + MAX_DATA_WORKSPACES);
    expect(new Set(desktop.workspaces.map((workspace) => workspace.name)).size).toBe(
      desktop.workspaces.length
    );
  });

  test('gives the same desktop for the same schema, with unique window ids', () => {
    const variables = [
      ...series('pose', 6),
      ...series('imu', 3),
      variable('maze', 'bytes', PERSIST),
    ];
    const first = autoLayout(variables);
    expect(autoLayout(variables)).toEqual(first);
    expect(new Set(first.windows.keys()).size).toBe(first.windows.size);
    expect(first.workspaces.flatMap((workspace) => leafIds(workspace.root))).toHaveLength(
      first.windows.size
    );
  });
});
