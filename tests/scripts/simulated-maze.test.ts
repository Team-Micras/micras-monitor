import { describe, expect, test } from 'vitest';

import { EXPLORED_16, FRESH_16, SMALL_3 } from '@tests/support/robots/micras/maze-vectors';
import { decodeMaze, Side, WallState } from '@robots/micras/maze';
import { encodeMaze, simulatedMaze, type MazeWalls } from '@scripts/simulated-robot/maze';
import { createVariables } from '@scripts/simulated-robot/variables';

function wallsOf(record: Uint8Array): MazeWalls {
  const maze = decodeMaze(record);
  const cells = Array.from({ length: maze.width * maze.height }, (_, index) => ({
    x: index % maze.width,
    y: Math.floor(index / maze.width),
  }));
  return {
    width: maze.width,
    height: maze.height,
    right: cells.map(({ x, y }) => maze.wall(x, y, Side.RIGHT)),
    up: cells.map(({ x, y }) => maze.wall(x, y, Side.UP)),
  };
}

describe('The simulated robot’s maze', () => {
  test.each([
    ['a fresh 16 × 16 maze', FRESH_16],
    ['an explored 16 × 16 maze', EXPLORED_16],
    ['a 3 × 3 maze', SMALL_3],
  ])('encodes %s byte for byte as the firmware does', (_, record) => {
    expect(encodeMaze(wallsOf(record))).toEqual(record);
  });

  test('is served as a 131 B record the Micras package decodes', () => {
    const served = createVariables()
      .find((variable) => variable.name === 'maze')
      ?.serialize?.();
    expect(served).toHaveLength(131);

    const maze = decodeMaze(served ?? new Uint8Array());
    expect(maze).toMatchObject({ width: 16, height: 16 });
    expect(maze.wall(0, 0, Side.RIGHT)).toBe(WallState.WALL);
    expect(maze.wall(0, 0, Side.UP)).toBe(WallState.NO_WALL);
    expect(maze.wall(0, 5, Side.UP)).toBe(WallState.WALL);
    expect(maze.wall(15, 15, Side.RIGHT)).toBe(WallState.WALL);
    expect(maze.exploredCount()).toBe(6);
    expect(served).toEqual(encodeMaze(simulatedMaze()));
  });
});
