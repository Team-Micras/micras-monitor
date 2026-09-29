/**
 * The maze of Micras as the firmware serializes it (`TMaze::serialize` in
 * `micras_nav/include/micras/nav/impl/maze.tpp`), with the tag `maze-grid`.
 *
 * The record is a version byte (1), the width and the height in cells, and then one nibble per
 * cell in row-major order from the bottom-left cell, the even cell in the low nibble: bits 0–1 are
 * the state of its right wall and bits 2–3 of its top wall. The left wall of the first column and
 * the bottom wall of the first row are the border, which is always a wall. A 16 × 16 maze is 131 B.
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

/** A side of a cell, with the firmware's values of `Side`. */
export const Side = {
  RIGHT: 0,
  UP: 1,
  LEFT: 2,
  DOWN: 3,
} as const;

/** A side of a cell. */
export type Side = (typeof Side)[keyof typeof Side];

/** A cell of the maze, x to the right and y up from the start corner. */
export interface Cell {
  readonly x: number;
  readonly y: number;
}

/** The type tag the firmware declares for the maze (`TMaze::type_tag`). */
export const MAZE_TYPE_TAG = 'maze-grid';

/** The version of the serialized format this decoder reads (`TMaze::format_version`). */
export const MAZE_FORMAT_VERSION = 1;

/** The side of a cell, in meters (`robot_model.maze.cell_size`). */
export const MAZE_CELL_SIZE_M = 0.18;

/** The cell the robot starts from (`maze_start` in `config/constants.hpp`). */
export const MAZE_START: Cell = { x: 0, y: 0 };

const HEADER_SIZE = 3;

/**
 * The cells of the goal for a maze of a size, as `maze_goal` in `config/constants.hpp` computes
 * them: the one to four cells at its center.
 */
export function goalCells(width: number, height: number): readonly Cell[] {
  const xs = [...new Set([Math.floor((width - 1) / 2), Math.floor(width / 2)])];
  const ys = [...new Set([Math.floor((height - 1) / 2), Math.floor(height / 2)])];
  return ys.flatMap((y) => xs.map((x) => ({ x, y })));
}

/** The number of bytes of a serialized maze of a size. */
export function serializedSize(width: number, height: number): number {
  return HEADER_SIZE + Math.ceil((width * height) / 2);
}

/** A decoded map of the walls of the maze. */
export class Maze {
  readonly width: number;
  readonly height: number;
  /** The cells of the goal, which the record does not carry but the firmware fixes by size. */
  readonly goal: readonly Cell[];
  readonly start: Cell = MAZE_START;
  readonly #right: readonly WallState[];
  readonly #up: readonly WallState[];

  /**
   * @param width The width in cells.
   * @param height The height in cells.
   * @param right The state of the right wall of every cell, row by row from the bottom.
   * @param up The state of the top wall of every cell, row by row from the bottom.
   */
  constructor(
    width: number,
    height: number,
    right: readonly WallState[],
    up: readonly WallState[]
  ) {
    this.width = width;
    this.height = height;
    this.goal = goalCells(width, height);
    this.#right = right;
    this.#up = up;
  }

  /** Tells whether a cell is inside the maze. */
  contains(x: number, y: number): boolean {
    return (
      Number.isInteger(x) &&
      Number.isInteger(y) &&
      x >= 0 &&
      y >= 0 &&
      x < this.width &&
      y < this.height
    );
  }

  /** What is known about a side of a cell; anything outside the maze is a wall, as in the firmware. */
  wall(x: number, y: number, side: Side): WallState {
    if (!this.contains(x, y)) {
      return WallState.WALL;
    }

    if (side === Side.RIGHT) {
      return this.#state(this.#right, x, y);
    }

    if (side === Side.UP) {
      return this.#state(this.#up, x, y);
    }

    if (side === Side.LEFT) {
      return x === 0 ? WallState.WALL : this.#state(this.#right, x - 1, y);
    }

    return y === 0 ? WallState.WALL : this.#state(this.#up, x, y - 1);
  }

  /** Tells whether every wall of a cell is known, which is when the search has seen it. */
  isExplored(x: number, y: number): boolean {
    return (
      this.contains(x, y) &&
      [Side.RIGHT, Side.UP, Side.LEFT, Side.DOWN].every(
        (side) => this.wall(x, y, side) !== WallState.UNKNOWN
      )
    );
  }

  /** Tells whether a cell belongs to the goal. */
  isGoal(x: number, y: number): boolean {
    return this.goal.some((cell) => cell.x === x && cell.y === y);
  }

  /** The number of cells whose walls are all known. */
  exploredCount(): number {
    let count = 0;

    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        count += this.isExplored(x, y) ? 1 : 0;
      }
    }

    return count;
  }

  #state(states: readonly WallState[], x: number, y: number): WallState {
    return states[y * this.width + x];
  }
}

/**
 * Decodes a maze from the bytes of the firmware's record.
 *
 * @throws {Error} When the record is short, of another version, of a size its length does not
 *   match, or holds a wall state the firmware never writes.
 */
export function decodeMaze(bytes: Uint8Array): Maze {
  if (bytes.length < HEADER_SIZE) {
    throw new Error(`a maze record has at least ${HEADER_SIZE} bytes, not ${bytes.length}`);
  }

  const [version, width, height] = bytes;

  if (version !== MAZE_FORMAT_VERSION) {
    throw new Error(`maze format version ${version} is not ${MAZE_FORMAT_VERSION}`);
  }

  if (width === 0 || height === 0) {
    throw new Error(`a maze of ${width} × ${height} cells has no cells`);
  }

  const expected = serializedSize(width, height);

  if (bytes.length !== expected) {
    throw new Error(`a ${width} × ${height} maze is ${expected} B, not ${bytes.length} B`);
  }

  const cells = width * height;
  const right: WallState[] = [];
  const up: WallState[] = [];

  for (let index = 0; index < cells; index++) {
    const packed = (bytes[HEADER_SIZE + (index >> 1)] >> (4 * (index % 2))) & 0x0f;
    right.push(wallState(packed & 0x03, index, width));
    up.push(wallState(packed >> 2, index, width));
  }

  return new Maze(width, height, right, up);
}

const WALL_STATES: readonly WallState[] = [WallState.UNKNOWN, WallState.NO_WALL, WallState.WALL];

function wallState(value: number, index: number, width: number): WallState {
  const state = WALL_STATES.at(value);

  if (state === undefined) {
    throw new Error(`cell ${index % width},${Math.floor(index / width)} has wall state ${value}`);
  }

  return state;
}
