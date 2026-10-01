import { describe, expect, test } from 'vitest';

import { desktopOf, windowOf } from '@tests/support/tiling/desktops';
import { deepFreeze, violationsOf } from '@tests/support/tiling/invariants';
import {
  activeWorkspace,
  addWorkspace,
  applyDrop,
  closeWindow,
  createWorkspace,
  execute,
  fitFloating,
  focusDirection,
  focusWindow,
  hitTest,
  layoutTree,
  layoutWorkspace,
  leafIds,
  moveToWorkspace,
  moveWindow,
  moveWorkspace,
  nudgeSplit,
  openWindow,
  placeFloating,
  removeWorkspace,
  renameWorkspace,
  resetSplit,
  resizeSplit,
  restoreDesktop,
  serializeDesktop,
  swapDirection,
  swapWindows,
  switchWorkspace,
  toggleFloating,
  toggleMaximize,
  workspaceOf,
  type Command,
  type Desktop,
  type Direction,
  type LayoutMetrics,
  type RemovePolicy,
  type Side,
  type WindowId,
} from '@/tiling';

const SEEDS = 200;
const STEPS = 80;
const NO_OP_SEEDS = 60;
const MAX_WINDOWS = 14;
const MAX_WORKSPACES = 5;
const DIRECTIONS: readonly Direction[] = ['left', 'right', 'up', 'down'];
const SIDES: readonly Side[] = ['left', 'right', 'top', 'bottom'];

type Random = () => number;

interface World {
  desktop: Desktop<string>;
  metrics: LayoutMetrics;
  opened: number;
  readonly random: Random;
}

type Operation = (world: World) => Desktop<string>;

/** Mulberry32: small, fast and fully determined by its seed. */
function seeded(seed: number): Random {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function between(random: Random, low: number, high: number): number {
  return low + Math.floor(random() * (high - low + 1));
}

function pick<T>(random: Random, items: readonly T[]): T | undefined {
  return items[Math.floor(random() * items.length)];
}

function randomMetrics(random: Random): LayoutMetrics {
  const tiny = random() < 0.3;
  return {
    width: tiny ? between(random, 10, 120) : between(random, 700, 1900),
    height: tiny ? between(random, 10, 90) : between(random, 450, 1100),
    gap: pick(random, [0, 8, 14]) ?? 14,
    outerGap: pick(random, [0, 14, 20]) ?? 14,
    minWidth: random() < 0.1 ? 1 : between(random, 120, 260),
    minHeight: random() < 0.1 ? 1 : between(random, 80, 160),
  };
}

function anyIndex(world: World): number {
  return between(world.random, 0, world.desktop.workspaces.length);
}

function anyDirection(world: World): Direction {
  return pick(world.random, DIRECTIONS) ?? 'up';
}

function anyWindow(world: World): WindowId | undefined {
  return pick(world.random, [...world.desktop.windows.keys()]);
}

function anyTiled(world: World): WindowId | undefined {
  return pick(
    world.random,
    world.desktop.workspaces.flatMap((workspace) => leafIds(workspace.root))
  );
}

function newWindow(world: World) {
  world.opened += 1;
  return windowOf(`w${world.opened}`);
}

function withWindow(world: World, run: (id: WindowId) => Desktop<string>): Desktop<string> {
  const id = anyWindow(world);
  return id === undefined ? world.desktop : run(id);
}

const open: Operation = (world) => {
  if (world.desktop.windows.size >= MAX_WINDOWS) {
    return world.desktop;
  }

  const target = world.random() < 0.3 ? anyTiled(world) : undefined;
  const side = pick(world.random, SIDES) ?? 'left';
  const share = world.random() < 0.5 ? world.random() : undefined;
  const at = target === undefined ? undefined : { target, side, share };
  return openWindow(world.desktop, newWindow(world), world.metrics, at);
};

const resize: Operation = (world) => {
  const { gutters } = layoutTree(activeWorkspace(world.desktop).root, world.metrics);
  const gutter = pick(world.random, gutters);

  if (gutter === undefined) {
    return world.desktop;
  }

  const choice = world.random();

  if (choice < 0.2) {
    return resetSplit(world.desktop, gutter.path, world.metrics);
  }

  if (choice < 0.4) {
    return nudgeSplit(world.desktop, gutter.path, world.random() - 0.5, world.metrics);
  }

  return resizeSplit(world.desktop, gutter.path, world.random(), world.metrics);
};

const drop: Operation = (world) => {
  const visible = layoutWorkspace(activeWorkspace(world.desktop), world.metrics)
    .windows.filter((window) => window.visible)
    .map((window) => window.id);
  const dragged = world.random() < 0.2 ? null : (pick(world.random, visible) ?? null);
  const point = {
    x: world.random() * world.metrics.width,
    y: world.random() * world.metrics.height,
  };
  const target = hitTest(world.desktop, dragged, point, world.metrics);

  if (target === null || target.kind === 'workspace') {
    return world.desktop;
  }

  if (dragged !== null) {
    const next = applyDrop(world.desktop, dragged, target, world.metrics);
    expect(next).not.toBe(world.desktop);
    expect(layoutTree(activeWorkspace(next).root, world.metrics).tiles.get(dragged)).toEqual(
      target.preview
    );
    return next;
  }

  if (target.kind !== 'edge' || world.desktop.windows.size >= MAX_WINDOWS) {
    return world.desktop;
  }

  const window = newWindow(world);
  const next = openWindow(world.desktop, window, world.metrics, {
    target: target.id,
    side: target.side,
  });
  expect(layoutTree(activeWorkspace(next).root, world.metrics).tiles.get(window.id)).toEqual(
    target.preview
  );
  return next;
};

const roundTrip: Operation = (world) => {
  const restored = restoreDesktop(JSON.parse(JSON.stringify(serializeDesktop(world.desktop))), {
    readPayload: (payload) => String(payload),
  });
  expect(restored).toEqual(world.desktop);
  return restored;
};

const command: Operation = (world) => {
  const focusTarget = anyWindow(world);
  const commands: readonly Command<string>[] = [
    { type: 'focusDirection', direction: anyDirection(world) },
    { type: 'focusNext' },
    { type: 'focusPrevious' },
    ...(focusTarget === undefined ? [] : [{ type: 'focusWindow', id: focusTarget } as const]),
    { type: 'swapDirection', direction: anyDirection(world) },
    { type: 'resize', direction: anyDirection(world), step: world.random() * 0.2 },
    { type: 'resetSplit', path: pick(world.random, ['', '0', '1', '01']) ?? '' },
    { type: 'toggleFloating' },
    { type: 'toggleMaximize' },
    { type: 'close' },
    { type: 'moveToWorkspace', index: anyIndex(world), follow: world.random() < 0.5 },
    { type: 'switchWorkspace', index: anyIndex(world) },
  ];
  const chosen = pick(world.random, commands) ?? { type: 'toggleMaximize' };
  return execute(world.desktop, chosen, world.metrics);
};

const lifecycle: Operation = (world) => {
  const choice = world.random();
  const count = world.desktop.workspaces.length;

  if (choice < 0.3) {
    return count >= MAX_WORKSPACES
      ? world.desktop
      : addWorkspace(world.desktop, `Workspace ${count + 1}`, anyIndex(world));
  }

  if (choice < 0.5) {
    return renameWorkspace(
      world.desktop,
      anyIndex(world),
      `Renamed ${between(world.random, 1, 3)}`
    );
  }

  if (choice < 0.7) {
    return moveWorkspace(world.desktop, anyIndex(world), anyIndex(world));
  }

  const policies: readonly RemovePolicy[] = [
    'closeWindows',
    'mergeIntoNeighbor',
    { mergeInto: anyIndex(world) },
  ];
  const policy = pick(world.random, policies) ?? 'closeWindows';
  return removeWorkspace(world.desktop, anyIndex(world), policy, world.metrics);
};

const OPERATIONS: Readonly<Record<string, Operation>> = {
  open,
  resize,
  drop,
  roundTrip,
  command,
  lifecycle,
  close: (world) => withWindow(world, (id) => closeWindow(world.desktop, id)),
  focus: (world) => withWindow(world, (id) => focusWindow(world.desktop, id)),
  focusDirection: (world) => focusDirection(world.desktop, anyDirection(world), world.metrics),
  swapDirection: (world) => swapDirection(world.desktop, anyDirection(world), world.metrics),
  moveToWorkspace: (world) =>
    withWindow(world, (id) =>
      moveToWorkspace(world.desktop, id, anyIndex(world), world.metrics, world.random() < 0.5)
    ),
  moveWindow: (world) => {
    const target = anyTiled(world);
    const side = pick(world.random, SIDES) ?? 'left';
    return target === undefined
      ? world.desktop
      : withWindow(world, (id) => moveWindow(world.desktop, id, { target, side }));
  },
  toggleFloating: (world) =>
    withWindow(world, (id) => toggleFloating(world.desktop, id, world.metrics)),
  toggleMaximize: (world) => toggleMaximize(world.desktop),
  placeFloating: (world) =>
    withWindow(world, (id) =>
      placeFloating(
        world.desktop,
        id,
        {
          x: between(world.random, -200, world.metrics.width + 200),
          y: between(world.random, -200, world.metrics.height + 200),
          width: between(world.random, 0, world.metrics.width),
          height: between(world.random, 0, world.metrics.height),
        },
        world.metrics
      )
    ),
  switchWorkspace: (world) => switchWorkspace(world.desktop, anyIndex(world)),
  resizeViewport: (world) => {
    world.metrics = randomMetrics(world.random);
    return world.desktop;
  },
};

const NAMES = Object.keys(OPERATIONS);

function initialWorld(seed: number): World {
  const random = seeded(seed);
  const desktop = desktopOf([
    createWorkspace('One'),
    createWorkspace('Two'),
    createWorkspace('Three'),
  ]);
  return { desktop: deepFreeze(desktop), metrics: randomMetrics(random), opened: 0, random };
}

function step(world: World): string {
  const name = pick(world.random, NAMES) ?? 'open';
  const before = world.desktop;
  const known = [...before.windows.keys()].join();
  world.desktop = deepFreeze(OPERATIONS[name](world));
  expect([...before.windows.keys()].join(), `${name} changed the map it was given`).toBe(known);
  return name;
}

type NoOp = readonly [string, () => boolean];

function sameAfter(desktop: Desktop<string>, run: (d: Desktop<string>) => Desktop<string>) {
  return () => run(desktop) === desktop;
}

function idempotent(desktop: Desktop<string>, run: (d: Desktop<string>) => Desktop<string>) {
  return () => {
    const once = run(desktop);
    return run(once) === once;
  };
}

/**
 * Operations that must hand back the very desktop they were given, because they ask for what is
 * already there or for something that does not apply, as names of the ones that did not.
 */
function brokenNoOps(world: World): string[] {
  const { desktop, metrics, random } = world;
  const id = anyWindow(world);
  const index = between(random, 0, desktop.workspaces.length - 1);
  const count = desktop.workspaces.length;
  const gutter = pick(random, layoutTree(activeWorkspace(desktop).root, metrics).gutters);
  const floating = pick(random, activeWorkspace(desktop).floating);
  const ratio = random();
  const always: readonly NoOp[] = [
    ['switchWorkspace to the active one', sameAfter(desktop, (d) => switchWorkspace(d, d.active))],
    ['switchWorkspace past the end', sameAfter(desktop, (d) => switchWorkspace(d, count))],
    ['moveWorkspace onto itself', sameAfter(desktop, (d) => moveWorkspace(d, index, index))],
    [
      'renameWorkspace to its name',
      sameAfter(desktop, (d) => renameWorkspace(d, index, d.workspaces[index].name)),
    ],
    ['closeWindow of a stranger', sameAfter(desktop, (d) => closeWindow(d, 'missing'))],
    [
      'toggleFloating of a stranger',
      sameAfter(desktop, (d) => toggleFloating(d, 'missing', metrics)),
    ],
    [
      'removeWorkspace of the last one',
      sameAfter(desktop, (d) => (count === 1 ? removeWorkspace(d, 0, 'closeWindows', metrics) : d)),
    ],
  ];
  const forWindow: readonly NoOp[] =
    id === undefined
      ? []
      : [
          ['swapWindows with itself', sameAfter(desktop, (d) => swapWindows(d, id, id))],
          [
            'moveToWorkspace past the end',
            sameAfter(desktop, (d) => moveToWorkspace(d, id, count, metrics)),
          ],
          [
            'moveToWorkspace to its own',
            sameAfter(desktop, (d) => moveToWorkspace(d, id, workspaceOf(d, id), metrics)),
          ],
          ['focusWindow twice', idempotent(desktop, (d) => focusWindow(d, id))],
        ];
  const forGutter: readonly NoOp[] =
    gutter === undefined
      ? []
      : [
          [
            'nudgeSplit by nothing',
            sameAfter(desktop, (d) => nudgeSplit(d, gutter.path, 0, metrics)),
          ],
          [
            'resizeSplit twice',
            idempotent(desktop, (d) => resizeSplit(d, gutter.path, ratio, metrics)),
          ],
        ];
  const forFloating: readonly NoOp[] =
    floating === undefined
      ? []
      : [
          [
            'placeFloating twice',
            idempotent(desktop, (d) =>
              placeFloating(d, floating.id, fitFloating(floating.rect, metrics), metrics)
            ),
          ],
        ];
  return [...always, ...forWindow, ...forGutter, ...forFloating]
    .filter(([, holds]) => !holds())
    .map(([name]) => name);
}

describe('after any sequence of operations', () => {
  test.each(Array.from({ length: SEEDS }, (_, seed) => seed + 1))(
    'seed %i keeps every invariant',
    (seed) => {
      const world = initialWorld(seed);
      const trail: string[] = [];

      for (let index = 0; index < STEPS; index++) {
        trail.push(step(world));
        expect(
          violationsOf(world.desktop, world.metrics),
          `step ${index}: ${trail.join(', ')}`
        ).toEqual([]);
      }
    }
  );

  test.each(Array.from({ length: NO_OP_SEEDS }, (_, seed) => seed + 1))(
    'seed %i returns the same desktop for every no-op',
    (seed) => {
      const world = initialWorld(seed);

      for (let index = 0; index < STEPS; index++) {
        const name = step(world);
        expect({ after: name, broken: brokenNoOps(world) }).toEqual({ after: name, broken: [] });
      }
    }
  );

  test('the generator is reproducible', () => {
    const first = seeded(42);
    const second = seeded(42);
    expect(Array.from({ length: 5 }, first)).toEqual(Array.from({ length: 5 }, second));
  });
});
