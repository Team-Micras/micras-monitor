/**
 * A maze the demo robot explores: a fixed 16 × 16 labyrinth whose cells it reveals one by one in
 * the order a depth-first walk from the start visits them, serialized as the Micras firmware
 * serializes its map, with the revision and the pose that go with it.
 *
 * @module
 */

const SIZE = 16;
const CELL_M = 0.18;
const SECONDS_PER_CELL = 0.5;
const UNKNOWN = 0;
const NO_WALL = 1;
const WALL = 2;
const STEPS = [
  [1, 0],
  [0, 1],
  [-1, 0],
  [0, -1],
] as const;

interface Labyrinth {
  /** Whether the right and the top side of each cell are open, row by row from the bottom. */
  readonly openRight: readonly boolean[];
  readonly openUp: readonly boolean[];
  /** The cells in the order the walk reaches them, the start first. */
  readonly walk: readonly number[];
}

function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };
}

function carve(): Labyrinth {
  const next = random(0x6d6963);
  const openRight = Array.from({ length: SIZE * SIZE }, () => false);
  const openUp = Array.from({ length: SIZE * SIZE }, () => false);
  const seen = new Set([0]);
  const walk = [0];
  const stack = [0];

  while (stack.length > 0) {
    const cell = stack[stack.length - 1];
    const x = cell % SIZE;
    const y = Math.floor(cell / SIZE);
    const options = STEPS.filter(([dx, dy]) => {
      const nx = x + dx;
      const ny = y + dy;
      return nx >= 0 && ny >= 0 && nx < SIZE && ny < SIZE && !seen.has(ny * SIZE + nx);
    });

    if (options.length === 0) {
      stack.pop();
      continue;
    }

    const [dx, dy] = options[Math.floor(next() * options.length)];
    const neighbor = (y + dy) * SIZE + x + dx;

    if (dx !== 0) {
      openRight[dx > 0 ? cell : neighbor] = true;
    } else {
      openUp[dy > 0 ? cell : neighbor] = true;
    }

    seen.add(neighbor);
    walk.push(neighbor);
    stack.push(neighbor);
  }

  return { openRight, openUp, walk };
}

const LABYRINTH = carve();

function revealed(seconds: number): number {
  return Math.min(LABYRINTH.walk.length, 1 + Math.floor(Math.max(0, seconds) / SECONDS_PER_CELL));
}

/** The revision of the demo maze at a time: one more for every cell revealed. */
export function demoMazeRevision(seconds: number): number {
  return revealed(seconds);
}

/** The demo maze at a time, as the 131 B record of the firmware. */
export function demoMazeRecord(seconds: number): Uint8Array {
  const known = new Set(LABYRINTH.walk.slice(0, revealed(seconds)));
  const bytes = new Uint8Array(3 + (SIZE * SIZE) / 2);
  bytes.set([1, SIZE, SIZE]);

  const state = (open: boolean, seenFrom: readonly number[], border: boolean): number => {
    if (border) {
      return WALL;
    }

    if (!seenFrom.some((cell) => known.has(cell))) {
      return UNKNOWN;
    }

    return open ? NO_WALL : WALL;
  };

  for (let cell = 0; cell < SIZE * SIZE; cell++) {
    const x = cell % SIZE;
    const y = Math.floor(cell / SIZE);
    const right = state(LABYRINTH.openRight[cell], [cell, cell + 1], x === SIZE - 1);
    const up = state(LABYRINTH.openUp[cell], [cell, cell + SIZE], y === SIZE - 1);
    bytes[3 + (cell >> 1)] |= (right | (up << 2)) << (4 * (cell % 2));
  }

  return bytes;
}

/** The position of the demo robot at a time, in meters: the center of the cell it last revealed. */
export function demoMazePosition(seconds: number): { readonly x: number; readonly y: number } {
  const cell = LABYRINTH.walk[revealed(seconds) - 1];
  return { x: ((cell % SIZE) + 0.5) * CELL_M, y: (Math.floor(cell / SIZE) + 0.5) * CELL_M };
}
