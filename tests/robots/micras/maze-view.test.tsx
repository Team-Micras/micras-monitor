import { describe, expect, test } from 'vitest';
import { render } from 'vitest-browser-react';

import { EXPLORED_16, FRESH_16 } from '@tests/support/robots/micras/maze-vectors';
import { decodeMaze } from '@/robots/micras/maze';
import { MazeView } from '@/robots/micras/maze-view';

function svg(): SVGSVGElement {
  const element = document.querySelector<SVGSVGElement>('[data-maze]');

  if (element === null) {
    throw new Error('no maze drawn');
  }

  return element;
}

describe('the maze view', () => {
  test('draws the walls and the explored cells of a fresh maze', async () => {
    await render(<MazeView value={decodeMaze(FRESH_16)} />);

    expect(svg().querySelector('title')?.textContent).toBe('Maze, 16 by 16, 1 cell explored');
    expect(svg().dataset.walls).toBe('65');
    expect(svg().dataset.robotCell).toBeUndefined();
    expect(document.querySelector('[data-robot]')).toBeNull();
  });

  test('draws the walls the robot observed', async () => {
    await render(<MazeView value={decodeMaze(EXPLORED_16)} />);

    expect(svg().dataset.walls).toBe('68');
    expect(svg().dataset.explored).toBe('2');
  });

  test('puts the robot at its pose, in the cell the firmware would place it', async () => {
    const screen = await render(
      <MazeView
        value={decodeMaze(FRESH_16)}
        roles={{ 'pose.x': 0.95, 'pose.y': 1.3, 'pose.heading': Math.PI }}
      />
    );

    expect(svg().dataset.robotCell).toBe('5,7');
    expect(document.querySelector('[data-robot]')).not.toBeNull();
    await expect.element(screen.getByText('cell 5,7 · W')).toBeVisible();
  });

  test('draws no robot at the pose the firmware holds before its first run', async () => {
    await render(
      <MazeView
        value={decodeMaze(FRESH_16)}
        roles={{ 'pose.x': 0.0000042, 'pose.y': -1.1e-7, 'pose.heading': -0.02 }}
      />
    );

    expect(document.querySelector('[data-robot]')).toBeNull();
    expect(svg().dataset.robotCell).toBeUndefined();
  });
});
