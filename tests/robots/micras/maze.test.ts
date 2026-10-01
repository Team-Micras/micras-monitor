import { describe, expect, test } from 'vitest';

import { EXPLORED_16, FRESH_16, SMALL_3 } from '@tests/support/robots/micras/maze-vectors';
import { decodeMaze, goalCells, Side, WallState, type Maze } from '@/robots/micras/maze';

const { UNKNOWN, NO_WALL, WALL } = WallState;

function sides(maze: Maze, x: number, y: number): readonly WallState[] {
  return [Side.RIGHT, Side.UP, Side.LEFT, Side.DOWN].map((side) => maze.wall(x, y, side));
}

/** Encodes walls with the layout of `TMaze::serialize`, independently of the decoder. */
function encode(width: number, height: number, right: number[], up: number[]): Uint8Array {
  const bytes = new Uint8Array(3 + Math.ceil((width * height) / 2));
  bytes.set([1, width, height]);

  for (let index = 0; index < width * height; index++) {
    bytes[3 + Math.floor(index / 2)] |= (right[index] | (up[index] << 2)) << (4 * (index % 2));
  }

  return bytes;
}

describe('decoding the firmware maze record', () => {
  test('reads a fresh 16 × 16 maze of 131 B as the firmware resets it', () => {
    const maze = decodeMaze(FRESH_16);

    expect(FRESH_16).toHaveLength(131);
    expect([maze.width, maze.height]).toEqual([16, 16]);
    expect(sides(maze, 0, 0)).toEqual([WALL, NO_WALL, WALL, WALL]);
    expect(sides(maze, 5, 0)).toEqual([UNKNOWN, UNKNOWN, UNKNOWN, WALL]);
    expect(sides(maze, 15, 15)).toEqual([WALL, WALL, UNKNOWN, UNKNOWN]);
    expect(sides(maze, 7, 7)).toEqual([NO_WALL, NO_WALL, UNKNOWN, UNKNOWN]);
    expect(sides(maze, 8, 8)).toEqual([UNKNOWN, UNKNOWN, NO_WALL, NO_WALL]);
    expect(maze.exploredCount()).toBe(1);
    expect(maze.isExplored(0, 0)).toBe(true);
  });

  test('reads the walls the firmware observed, from both of their cells', () => {
    const maze = decodeMaze(EXPLORED_16);

    expect(sides(maze, 0, 1)).toEqual([WALL, NO_WALL, WALL, NO_WALL]);
    expect(sides(maze, 1, 1)[Side.LEFT]).toBe(WALL);
    expect(sides(maze, 1, 1)[Side.UP]).toBe(WALL);
    expect(sides(maze, 1, 2)).toEqual([UNKNOWN, UNKNOWN, NO_WALL, WALL]);
    expect(maze.wall(4, 9, Side.RIGHT)).toBe(WALL);
    expect(maze.wall(15, 14, Side.UP)).toBe(NO_WALL);
    expect(maze.exploredCount()).toBe(2);
  });

  test('reads an odd number of cells, whose last byte has one nibble', () => {
    const maze = decodeMaze(SMALL_3);

    expect(sides(maze, 0, 0)).toEqual([NO_WALL, WALL, WALL, WALL]);
    expect(maze.wall(1, 1, Side.UP)).toBe(WALL);
    expect(maze.wall(1, 1, Side.DOWN)).toBe(NO_WALL);
    expect(maze.wall(2, 2, Side.RIGHT)).toBe(WALL);
  });

  test('matches an encoding built from the firmware layout, cell by cell', () => {
    const width = 5;
    const height = 4;
    const right = Array.from({ length: width * height }, (_, index) => (index * 7) % 3);
    const up = Array.from({ length: width * height }, (_, index) => (index * 5 + 1) % 3);
    const maze = decodeMaze(encode(width, height, right, up));

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        expect(maze.wall(x, y, Side.RIGHT)).toBe(right[y * width + x]);
        expect(maze.wall(x, y, Side.UP)).toBe(up[y * width + x]);
      }
    }
  });

  test('treats everything outside the maze as a wall', () => {
    const maze = decodeMaze(FRESH_16);

    expect(maze.wall(-1, 0, Side.RIGHT)).toBe(WALL);
    expect(maze.wall(16, 3, Side.UP)).toBe(WALL);
    expect(maze.isExplored(16, 0)).toBe(false);
  });

  test.each<[string, Uint8Array, string]>([
    ['a short record', new Uint8Array([1, 16]), 'at least 3 bytes'],
    ['another version', Uint8Array.of(2, ...FRESH_16.slice(1)), 'version 2'],
    ['a record of the wrong size', FRESH_16.slice(0, 130), 'is 131 B, not 130 B'],
    ['a maze without cells', new Uint8Array([1, 0, 16]), 'has no cells'],
    ['a wall state the firmware never writes', new Uint8Array([1, 1, 1, 0x03]), 'wall state 3'],
  ])('refuses %s', (_name, bytes, message) => {
    expect(() => decodeMaze(bytes)).toThrow(message);
  });
});

describe('the goal', () => {
  test('is the four center cells of an even maze, as the firmware computes it', () => {
    expect(goalCells(16, 16)).toEqual([
      { x: 7, y: 7 },
      { x: 8, y: 7 },
      { x: 7, y: 8 },
      { x: 8, y: 8 },
    ]);
    expect(decodeMaze(FRESH_16).isGoal(8, 7)).toBe(true);
    expect(decodeMaze(FRESH_16).isGoal(6, 7)).toBe(false);
  });

  test('is the center cell of an odd maze', () => {
    expect(goalCells(3, 3)).toEqual([{ x: 1, y: 1 }]);
    expect(decodeMaze(SMALL_3).goal).toEqual([{ x: 1, y: 1 }]);
  });
});
