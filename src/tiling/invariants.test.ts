import { describe, expect, test } from 'vitest';

import { desktopOf, windowOf } from './fixtures/desktops';
import { violationsOf } from './fixtures/invariants';
import {
  activeWorkspace,
  applyDrop,
  closeWindow,
  createWorkspace,
  execute,
  focusDirection,
  focusWindow,
  hitTest,
  layoutTree,
  layoutWorkspace,
  leafIds,
  moveToWorkspace,
  moveWindow,
  nudgeSplit,
  openWindow,
  placeFloating,
  resetSplit,
  resizeSplit,
  restoreDesktop,
  serializeDesktop,
  swapDirection,
  switchWorkspace,
  toggleFloating,
  toggleMaximize,
  type Command,
  type Desktop,
  type Direction,
  type LayoutMetrics,
  type Side,
  type WindowId,
} from './index';

const SEEDS = 200;
const STEPS = 80;
const MAX_WINDOWS = 14;
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
  return {
    width: between(random, 700, 1900),
    height: between(random, 450, 1100),
    gap: pick(random, [0, 8, 14]) ?? 14,
    outerGap: pick(random, [0, 14, 20]) ?? 14,
    minWidth: between(random, 120, 260),
    minHeight: between(random, 80, 160),
  };
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
  const at = target === undefined ? undefined : { target, side };
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
    .windows.filter((window) => window.visible && !window.floating)
    .map((window) => window.id);
  const dragged = world.random() < 0.2 ? null : (pick(world.random, visible) ?? null);
  const point = {
    x: world.random() * world.metrics.width,
    y: world.random() * world.metrics.height,
  };
  const target = hitTest(world.desktop, dragged, point, world.metrics);

  if (target === null) {
    return world.desktop;
  }

  if (dragged !== null) {
    const next = applyDrop(world.desktop, dragged, target, world.metrics);
    const landed = layoutTree(activeWorkspace(next).root, world.metrics).tiles.get(dragged);
    expect(target.kind === 'workspace' ? null : landed).toEqual(
      target.kind === 'workspace' ? null : target.preview
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
  const landed = layoutTree(activeWorkspace(next).root, world.metrics).tiles.get(window.id);
  expect(landed).toEqual(target.preview);
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
  const commands: readonly Command<string>[] = [
    { type: 'focusDirection', direction: pick(world.random, DIRECTIONS) ?? 'up' },
    { type: 'swapDirection', direction: pick(world.random, DIRECTIONS) ?? 'up' },
    { type: 'toggleFloating' },
    { type: 'toggleMaximize' },
    { type: 'close' },
    { type: 'moveToWorkspace', index: between(world.random, 0, 2), follow: world.random() < 0.5 },
    { type: 'switchWorkspace', index: between(world.random, 0, 2) },
  ];
  const chosen = pick(world.random, commands) ?? { type: 'toggleMaximize' };
  return execute(world.desktop, chosen, world.metrics);
};

const OPERATIONS: Readonly<Record<string, Operation>> = {
  open,
  resize,
  drop,
  roundTrip,
  command,
  close: (world) => withWindow(world, (id) => closeWindow(world.desktop, id)),
  focus: (world) => withWindow(world, (id) => focusWindow(world.desktop, id)),
  focusDirection: (world) =>
    focusDirection(world.desktop, pick(world.random, DIRECTIONS) ?? 'up', world.metrics),
  swapDirection: (world) =>
    swapDirection(world.desktop, pick(world.random, DIRECTIONS) ?? 'up', world.metrics),
  moveToWorkspace: (world) =>
    withWindow(world, (id) =>
      moveToWorkspace(
        world.desktop,
        id,
        between(world.random, 0, 2),
        world.metrics,
        world.random() < 0.5
      )
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
  switchWorkspace: (world) => switchWorkspace(world.desktop, between(world.random, 0, 2)),
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
  return { desktop, metrics: randomMetrics(random), opened: 0, random };
}

describe('after any sequence of operations', () => {
  test.each(Array.from({ length: SEEDS }, (_, seed) => seed + 1))(
    'seed %i keeps every invariant',
    (seed) => {
      const world = initialWorld(seed);
      const trail: string[] = [];

      for (let step = 0; step < STEPS; step++) {
        const name = pick(world.random, NAMES) ?? 'open';
        trail.push(name);
        world.desktop = OPERATIONS[name](world);
        expect(
          violationsOf(world.desktop, world.metrics),
          `step ${step}: ${trail.join(', ')}`
        ).toEqual([]);
      }
    }
  );

  test('the generator is reproducible', () => {
    const first = seeded(42);
    const second = seeded(42);
    expect(Array.from({ length: 5 }, first)).toEqual(Array.from({ length: 5 }, second));
  });
});
