/**
 * The maze the simulated robot serves, as the firmware serializes one (`TMaze::serialize` in
 * `micras_nav/include/micras/nav/impl/maze.tpp`, tag `maze-grid`), so the Micras package decodes
 * and draws it.
 *
 * The record is a version byte (1), the width and the height in cells, and then one nibble per
 * cell in row-major order from the bottom-left cell, the even cell in the low nibble: bits 0–1 are
 * the state of its right wall and bits 2–3 of its top wall. A 16 × 16 maze is 131 B.
 *
 * @module
 */

/** What is known about a wall, with the firmware's values of `WallState`. */
export const WallState = {
  UNKNOWN: 0,
  NO_WALL: 1,
  WALL: 2,
} as const;

/** What is known about a wall. */
export type WallState = (typeof WallState)[keyof typeof WallState];

/** The walls of a maze, cell by cell, row by row from the bottom-left one. */
export interface MazeWalls {
  readonly width: number;
  readonly height: number;
  /** The state of the right wall of every cell. */
  readonly right: readonly WallState[];
  /** The state of the top wall of every cell. */
  readonly up: readonly WallState[];
}

const FORMAT_VERSION = 1;
const HEADER_SIZE = 3;
const SIZE = 16;
const CORRIDOR = 6;

/** Serializes the walls of a maze into the firmware's record. */
export function encodeMaze({ width, height, right, up }: MazeWalls): Uint8Array {
  const record = new Uint8Array(HEADER_SIZE + Math.ceil((width * height) / 2));
  record.set([FORMAT_VERSION, width, height]);

  for (let index = 0; index < width * height; index++) {
    const nibble = (right[index] | (up[index] << 2)) << (4 * (index % 2));
    record[HEADER_SIZE + (index >> 1)] |= nibble;
  }

  return record;
}

/**
 * The 16 × 16 maze of the simulated robot: its outer walls, and a corridor the search went up
 * from the start cell, open ahead and walled on its right, closed at its end.
 */
export function simulatedMaze(): MazeWalls {
  const cells = SIZE * SIZE;
  const right = Array.from<WallState>({ length: cells }).fill(WallState.UNKNOWN);
  const up = Array.from<WallState>({ length: cells }).fill(WallState.UNKNOWN);

  for (let y = 0; y < SIZE; y++) {
    right[y * SIZE + SIZE - 1] = WallState.WALL;
  }

  for (let x = 0; x < SIZE; x++) {
    up[(SIZE - 1) * SIZE + x] = WallState.WALL;
  }

  for (let y = 0; y < CORRIDOR; y++) {
    right[y * SIZE] = WallState.WALL;
    up[y * SIZE] = y === CORRIDOR - 1 ? WallState.WALL : WallState.NO_WALL;
  }

  return { width: SIZE, height: SIZE, right, up };
}
