import { describe, expect, test } from 'vitest';

import type { LayoutPreset } from '@/core/robot';
import { createDesktop, leafIds, activeWorkspace } from '@/tiling';

import {
  presetDesktop,
  presetWorkspace,
  readPresets,
  workspacePreset,
} from '@/app/layouts/presets';

const PRESET: LayoutPreset = {
  name: 'Tracking',
  root: {
    split: 'column',
    ratio: 0.4,
    first: { window: { kind: 'plot', title: 'Speed', variables: ['pose/v', 'reference/v'] } },
    second: {
      split: 'row',
      ratio: 0.5,
      first: { window: { kind: 'robot' } },
      second: { window: { kind: 'log' } },
    },
  },
};

describe('a preset as a workspace', () => {
  test('builds the windows and the tiles it describes', () => {
    const { workspace, windows } = presetWorkspace(PRESET, 'Tracking', (kind) => `${kind}-1`);
    expect(workspace.name).toBe('Tracking');
    expect(leafIds(workspace.root)).toEqual(['plot-1', 'robot-1', 'log-1']);
    expect(windows[0]).toEqual({
      id: 'plot-1',
      kind: 'plot',
      payload: { title: 'Speed', variables: ['pose/v', 'reference/v'] },
    });
    expect(windows[1].payload).toEqual({ variables: [] });
    expect(workspace.root).toMatchObject({ type: 'split', orientation: 'column', ratio: 0.4 });
  });

  test('makes an empty workspace of a preset without a tree', () => {
    const { workspace, windows } = presetWorkspace({ name: 'Blank', root: null }, 'Blank', String);
    expect(workspace.root).toBeNull();
    expect(windows).toEqual([]);
  });

  test('makes a workspace of each preset for the desktop a robot opens with', () => {
    const desktop = presetDesktop([PRESET, { name: 'Blank', root: null }]);
    expect(desktop.workspaces.map((workspace) => workspace.name)).toEqual(['Tracking', 'Blank']);
    expect(new Set(desktop.windows.keys()).size).toBe(3);
  });

  test('describes a workspace as the preset it was built from', () => {
    const desktop = presetDesktop([PRESET]);
    expect(workspacePreset(desktop, 0, 'Tracking')).toEqual(PRESET);
    expect(workspacePreset(desktop, 0, 'Copy').name).toBe('Copy');
  });

  test('leaves floating windows out of a preset', () => {
    const desktop = presetDesktop([PRESET]);
    const floated = createDesktop(
      [{ ...activeWorkspace(desktop), floating: [] }],
      desktop.windows.values()
    );
    expect(workspacePreset(floated, 0, 'X').root).toEqual(PRESET.root);
  });
});

describe('presets read back from storage', () => {
  test('keeps valid presets and drops what is malformed or repeats a name', () => {
    const stored: unknown = JSON.parse(
      JSON.stringify([
        PRESET,
        { name: 'Tracking', root: null },
        { name: '', root: null },
        {
          name: 'Bad ratio',
          root: { split: 'row', ratio: 1, first: PRESET.root, second: PRESET.root },
        },
        { name: 'Bad window', root: { window: { kind: 3 } } },
        { name: 'Bad variables', root: { window: { kind: 'plot', variables: [1] } } },
        { name: 'Blank', root: null },
        'nope',
      ])
    );
    expect(readPresets(stored)).toEqual([PRESET, { name: 'Blank', root: null }]);
  });

  test('reads nothing from what is not a list', () => {
    expect(readPresets(undefined)).toEqual([]);
    expect(readPresets({})).toEqual([]);
  });
});
