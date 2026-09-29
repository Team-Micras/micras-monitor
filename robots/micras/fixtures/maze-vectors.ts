/**
 * Maze records the firmware's own `TMaze::serialize` wrote (MicrasFirmware 8ae3bbd), printed by
 * `maze-vectors.cpp` next to this file.
 *
 * @module
 */

/** A fresh 16 × 16 maze: start at 0,0 facing up, the goal at the four center cells. */
export const FRESH_16 = new Uint8Array([
  1, 16, 16, 6, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 0,
  0, 0, 0, 32, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0,
  80, 4, 0, 0, 32, 0, 0, 0, 16, 0, 0, 0, 32, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0,
  0, 0, 0, 0, 0, 32, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 0, 0, 0, 0, 32, 136,
  136, 136, 136, 136, 136, 136, 168,
]);

/**
 * The fresh maze after seven observations: 0,1 right wall, 0,1 up open, 0,2 right open, 1,2 down
 * wall, 1,2 left open, 5,9 left wall and 15,15 down open.
 */
export const EXPLORED_16 = new Uint8Array([
  1, 16, 16, 6, 0, 0, 0, 0, 0, 0, 32, 134, 0, 0, 0, 0, 0, 0, 32, 1, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0,
  0, 0, 0, 0, 32, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0,
  0, 80, 4, 0, 0, 32, 0, 0, 0, 16, 0, 0, 0, 32, 0, 0, 2, 0, 0, 0, 0, 32, 0, 0, 0, 0, 0, 0, 0, 32, 0,
  0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 0, 0, 0, 0, 32, 0, 0, 0, 0, 0, 0, 0, 96,
  136, 136, 136, 136, 136, 136, 136, 168,
]);

/**
 * A 3 × 3 maze, an odd number of cells: start at 0,0 facing right, the goal at the center 1,1 as
 * the decoder computes it, 1,1 up wall and 1,0 up open.
 */
export const SMALL_3 = new Uint8Array([1, 3, 3, 73, 2, 40, 136, 10]);
