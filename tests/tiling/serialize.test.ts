import { describe, expect, test } from 'vitest';

import { METRICS, overview } from '@tests/support/tiling/desktops';
import {
  createDesktop,
  createWorkspace,
  focusWindow,
  LAYOUT_VERSION,
  LayoutError,
  leaf,
  moveToWorkspace,
  restoreDesktop,
  serializeDesktop,
  split,
  toggleFloating,
  toggleMaximize,
  type Migration,
  type Workspace,
} from '@/tiling';

interface PlotPayload {
  readonly series: readonly string[];
}

function readPlot(value: unknown, path: string): PlotPayload {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('series' in value) ||
    !Array.isArray(value.series) ||
    !value.series.every((entry) => typeof entry === 'string')
  ) {
    throw new LayoutError(path, 'must list series names');
  }

  return { series: value.series };
}

type Snapshot = ReturnType<typeof JSON.parse>;

function snapshotOf(): Snapshot {
  let d = toggleFloating(overview(), 'profile', METRICS);
  d = toggleMaximize(focusWindow(d, 'maze'));
  return JSON.parse(JSON.stringify(serializeDesktop(d)));
}

function rejectionOf(change: (snapshot: Snapshot) => void): string {
  const snapshot = snapshotOf();
  change(snapshot);

  try {
    restoreDesktop(snapshot);
  } catch (error) {
    return error instanceof LayoutError ? error.message : `not a LayoutError: ${String(error)}`;
  }

  return 'accepted';
}

function errorOf(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }

  return null;
}

function refuse(): never {
  throw new Error('bad payload');
}

function versionZero(): Snapshot {
  const current = snapshotOf();
  current.version = 0;

  for (const workspace of current.workspaces) {
    workspace.focused = workspace.focus[0] ?? null;
    delete workspace.focus;
  }

  return current;
}

const focusFromFocused: Migration = (old) => {
  const workspaces: Snapshot[] = Array.isArray(old.workspaces) ? old.workspaces : [];
  return {
    ...old,
    workspaces: workspaces.map(({ name, root, floating, maximized, focused }) => ({
      name,
      root,
      floating,
      maximized,
      focus: focused === null ? [] : [focused],
    })),
  };
};

describe('round trip', () => {
  test('restores floating windows, dock memory, maximize, focus history and payloads', () => {
    let d = createDesktop(
      [
        createWorkspace('Overview', split('row', 0.35, leaf('plot'), leaf('maze'))),
        createWorkspace('Sensors'),
      ],
      [
        { id: 'plot', kind: 'plot', payload: { series: ['x', 'y'] } },
        { id: 'maze', kind: 'maze', payload: { series: [] } },
      ]
    );
    d = toggleFloating(d, 'maze', METRICS);
    d = moveToWorkspace(focusWindow(d, 'plot'), 'plot', 1, METRICS, false);
    d = toggleMaximize(d);
    const json = JSON.stringify(serializeDesktop(d));
    const restored = restoreDesktop(JSON.parse(json), { readPayload: readPlot });
    expect(restored).toEqual(d);
    expect(JSON.stringify(serializeDesktop(restored))).toBe(json);
  });

  test('writes the current version and can convert payloads on the way out', () => {
    const snapshot = serializeDesktop(overview(), (payload) => ({ saved: payload }));
    expect(snapshot.version).toBe(LAYOUT_VERSION);
    expect(snapshot.windows[0].payload).toEqual({ saved: 'track' });
  });
});

describe('validation', () => {
  const cases: readonly [string, (snapshot: Snapshot) => void, string][] = [
    ['a version that is not an integer', (s) => (s.version = '1'), 'version must be an integer'],
    [
      'a ratio out of range',
      (s) => (s.workspaces[0].root.ratio = 1.5),
      'workspaces[0].root.ratio is 1.5; it must lie strictly between 0 and 1',
    ],
    [
      'an unknown orientation',
      (s) => (s.workspaces[0].root.first.orientation = 'diagonal'),
      'workspaces[0].root.first.orientation must be one of "row", "column"',
    ],
    [
      'an unknown node type',
      (s) => (s.workspaces[0].root.second = { type: 'tab' }),
      'workspaces[0].root.second.type must be "leaf" or "split"',
    ],
    [
      'a leaf without an id',
      (s) => delete s.workspaces[0].root.first.first.id,
      'workspaces[0].root.first.first.id must be a non-empty string',
    ],
    [
      'a tiled window missing from windows',
      (s) => s.windows.shift(),
      'workspaces[0].root.first.first.id places "track", which is not in windows',
    ],
    [
      'a window placed nowhere',
      (s) => s.windows.push({ id: 'ghost', kind: 'test', payload: null }),
      'windows[4] "ghost" is in no workspace',
    ],
    ['a window listed twice', (s) => s.windows.push(s.windows[0]), 'windows[4].id repeats "track"'],
    [
      'a focus on a stranger',
      (s) => (s.workspaces[0].focus[0] = 'nobody'),
      'workspaces[0].focus[0] "nobody" is not a window of this workspace',
    ],
    [
      'an empty focus on a busy workspace',
      (s) => (s.workspaces[0].focus = []),
      'workspaces[0].focus must name the focused window',
    ],
    [
      'a floating window maximized',
      (s) => (s.workspaces[0].maximized = 'profile'),
      'workspaces[0].maximized "profile" is not tiled in this workspace',
    ],
    [
      'a rect with a text width',
      (s) => (s.workspaces[0].floating[0].rect.width = 'wide'),
      'workspaces[0].floating[0].rect.width must be a finite number',
    ],
    [
      'a dock memory on an unknown side',
      (s) => (s.workspaces[0].floating[0].dock.side = 'middle'),
      'workspaces[0].floating[0].dock.side must be one of "left", "right", "top", "bottom"',
    ],
    [
      'an active index past the end',
      (s) => (s.active = 5),
      'active is 5, which is not a workspace index',
    ],
    ['no workspaces', (s) => (s.workspaces = []), 'workspaces must hold at least one workspace'],
    [
      'a version from the future',
      (s) => (s.version = 99),
      'version is 99, newer than 1, the latest known',
    ],
  ];

  test.each(cases)('rejects %s', (_, change, message) => {
    expect(rejectionOf(change)).toBe(message);
  });

  test('rejects a value that is not an object', () => {
    expect(() => restoreDesktop('layout')).toThrow('snapshot must be an object');
    expect(() => restoreDesktop(null)).toThrow('snapshot must be an object');
  });

  test('reports a payload the reader refuses against its path', () => {
    const snapshot = snapshotOf();
    expect(() => restoreDesktop(snapshot, { readPayload: refuse })).toThrow(
      'windows[0].payload is not a valid payload: Error: bad payload'
    );
    expect(() => restoreDesktop(snapshot, { readPayload: readPlot })).toThrow(
      new LayoutError('windows[0].payload', 'must list series names')
    );
  });

  test('names the field in the error path', () => {
    const snapshot = snapshotOf();
    snapshot.workspaces[0].root.ratio = 0;
    const error = errorOf(() => restoreDesktop(snapshot));
    expect(error).toBeInstanceOf(LayoutError);
    expect(error).toHaveProperty('path', 'workspaces[0].root.ratio');
  });
});

describe('migrations', () => {
  test('bring an older snapshot up to the current version before it is read', () => {
    const restored = restoreDesktop(versionZero(), { migrations: { 0: focusFromFocused } });
    expect(restored.workspaces[0].focus).toEqual(['maze']);
    expect(restored.workspaces[1].focus).toEqual([]);
  });

  test('a version without a migration is rejected', () => {
    expect(() => restoreDesktop(versionZero())).toThrow(
      'version is 0, which has no migration to 1'
    );
  });
});

function goldenDesktop() {
  const spare: Workspace = {
    name: 'Spare',
    root: leaf('log'),
    floating: [
      {
        id: 'note',
        rect: { x: 10, y: 20, width: 300, height: 200 },
        dock: { siblings: ['log'], side: 'left', ratio: 0.5 },
      },
    ],
    focus: ['note', 'log'],
    maximized: 'log',
  };
  return createDesktop<unknown>(
    [createWorkspace('Main', split('row', 0.25, leaf('plot'), leaf('maze'))), spare],
    [
      { id: 'plot', kind: 'plot', payload: { series: ['x'] } },
      { id: 'maze', kind: 'maze', payload: null },
      { id: 'log', kind: 'log', payload: null },
      { id: 'note', kind: 'note', payload: 'hi' },
    ],
    1
  );
}

function versionZeroOf(migration: Migration) {
  return () => restoreDesktop({ ...snapshotOf(), version: 0 }, { migrations: { 0: migration } });
}

const boom: Migration = () => {
  throw new Error('boom');
};

const list: Migration = () => JSON.parse('[]');

function withDock(dock: unknown): Workspace {
  return {
    ...createWorkspace('W', leaf('a')),
    floating: [
      {
        id: 'f',
        rect: { x: 0, y: 0, width: 10, height: 10 },
        dock: JSON.parse(JSON.stringify(dock)),
      },
    ],
  };
}

describe('format version 1', () => {
  const golden = {
    version: 1,
    active: 1,
    windows: [
      { id: 'plot', kind: 'plot', payload: { series: ['x'] } },
      { id: 'maze', kind: 'maze', payload: null },
      { id: 'log', kind: 'log', payload: null },
      { id: 'note', kind: 'note', payload: 'hi' },
    ],
    workspaces: [
      {
        name: 'Main',
        root: {
          type: 'split',
          orientation: 'row',
          ratio: 0.25,
          first: { type: 'leaf', id: 'plot' },
          second: { type: 'leaf', id: 'maze' },
        },
        floating: [],
        focus: ['plot'],
        maximized: null,
      },
      {
        name: 'Spare',
        root: { type: 'leaf', id: 'log' },
        floating: [
          {
            id: 'note',
            rect: { x: 10, y: 20, width: 300, height: 200 },
            dock: { siblings: ['log'], side: 'left', ratio: 0.5 },
          },
        ],
        focus: ['note', 'log'],
        maximized: 'log',
      },
    ],
  };

  test('is written field for field, in this order', () => {
    expect(JSON.stringify(serializeDesktop(goldenDesktop()))).toBe(JSON.stringify(golden));
  });

  test('is read back into the same desktop', () => {
    expect(restoreDesktop(golden)).toEqual(goldenDesktop());
  });
});

describe('failing migrations', () => {
  test('report the version when they throw', () => {
    expect(versionZeroOf(boom)).toThrow(
      new LayoutError('version', 'is 0, and its migration to 1 failed: Error: boom')
    );
  });

  test('report the version when they return something other than an object', () => {
    expect(versionZeroOf(list)).toThrow(
      new LayoutError('version', 'is 0, and its migration to 1 did not return an object')
    );
  });
});

describe('validating a desktop built in code', () => {
  test('rejects unknown node types and orientations as layout errors', () => {
    const tab: Workspace = { ...createWorkspace('W'), root: JSON.parse('{"type":"tab"}') };
    expect(() => createDesktop([tab])).toThrow(
      new LayoutError('workspaces[0].root.type', 'must be one of "leaf", "split"')
    );
    const diagonal: Workspace = {
      ...createWorkspace('W', split('row', 0.5, leaf('a'), leaf('b'))),
      root: JSON.parse(
        '{"type":"split","orientation":"diagonal","ratio":0.5,"first":{"type":"leaf","id":"a"},"second":{"type":"leaf","id":"b"}}'
      ),
    };
    expect(() =>
      createDesktop(
        [diagonal],
        [
          { id: 'a', kind: 'k', payload: null },
          { id: 'b', kind: 'k', payload: null },
        ]
      )
    ).toThrow('workspaces[0].root.orientation must be one of "row", "column"');
  });

  test('rejects dock memories with a repeated window or an unknown side', () => {
    const windows = [
      { id: 'a', kind: 'k', payload: null },
      { id: 'f', kind: 'k', payload: null },
    ];
    expect(() =>
      createDesktop([withDock({ siblings: ['a', 'a'], side: 'left', ratio: 0.5 })], windows)
    ).toThrow('workspaces[0].floating[0].dock.siblings[1] "a" is listed twice');
    expect(() =>
      createDesktop([withDock({ siblings: ['a'], side: 'middle', ratio: 0.5 })], windows)
    ).toThrow(
      'workspaces[0].floating[0].dock.side must be one of "left", "right", "top", "bottom"'
    );
  });
});
