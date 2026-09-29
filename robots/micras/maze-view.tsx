import { useId } from 'react';

import type { TypeViewProps } from '@/robot-kit';

import { MAZE_CELL_SIZE_M, Side, WallState, type Maze } from './maze';

const LABEL_EVERY = 3;
const MARGIN_LEFT = 1.1;
const MARGIN_BOTTOM = 0.9;
const MARGIN_EDGE = 0.25;
const POST = 0.08;
const HEADINGS = ['E', 'N', 'W', 'S'] as const;
const MAX_GRID_INDEX = 255;
const UNLOCALIZED_RADIUS_M = 0.001;

/**
 * Where the robot is on the maze, in cells: 0.5 is the center of the first cell. Its cell is
 * clamped to the first quadrant, as `GridPoint::from_vector` does. A pose within a millimeter of
 * 0, 0 is the one the firmware holds, drifting, before its first run: the corner post, where no
 * robot fits, so it draws no robot.
 */
interface GridPose {
  readonly x: number;
  readonly y: number;
  readonly heading: number;
}

function gridPose(roles: TypeViewProps<Maze>['roles']): GridPose | null {
  const x = roles?.['pose.x'];
  const y = roles?.['pose.y'];

  if (x === undefined || y === undefined || !Number.isFinite(x) || !Number.isFinite(y)) {
    return null;
  }

  if (Math.hypot(x, y) < UNLOCALIZED_RADIUS_M) {
    return null;
  }

  const heading = roles?.['pose.heading'];
  return {
    x: x / MAZE_CELL_SIZE_M,
    y: y / MAZE_CELL_SIZE_M,
    heading: heading !== undefined && Number.isFinite(heading) ? heading : Math.PI / 2,
  };
}

function gridIndex(coordinate: number): number {
  return Math.min(Math.max(Math.floor(coordinate), 0), MAX_GRID_INDEX);
}

function headingName(heading: number): string {
  const quarter = Math.round(heading / (Math.PI / 2));
  return HEADINGS[((quarter % 4) + 4) % 4];
}

function segment(x1: number, y1: number, x2: number, y2: number): string {
  return `M${x1} ${y1}L${x2} ${y2}`;
}

interface MazePaths {
  readonly walls: string;
  readonly unknown: string;
  readonly explored: string;
  readonly posts: string;
  readonly wallCount: number;
  readonly exploredCount: number;
}

function mazePaths(maze: Maze): MazePaths {
  const top = (y: number) => maze.height - 1 - y;
  const walls: string[] = [];
  const unknown: string[] = [];
  const explored: string[] = [];
  const posts: string[] = [];
  let wallCount = 0;

  const add = (state: WallState, path: string) => {
    if (state === WallState.WALL) {
      walls.push(path);
      wallCount++;
    } else if (state === WallState.UNKNOWN) {
      unknown.push(path);
    }
  };

  for (let y = 0; y < maze.height; y++) {
    for (let x = 0; x < maze.width; x++) {
      const t = top(y);
      add(maze.wall(x, y, Side.RIGHT), segment(x + 1, t, x + 1, t + 1));
      add(maze.wall(x, y, Side.UP), segment(x, t, x + 1, t));

      if (x === 0) {
        add(maze.wall(x, y, Side.LEFT), segment(0, t, 0, t + 1));
      }

      if (y === 0) {
        add(maze.wall(x, y, Side.DOWN), segment(x, t + 1, x + 1, t + 1));
      }

      if (maze.isExplored(x, y)) {
        explored.push(`M${x} ${t}h1v1h-1z`);
      }
    }
  }

  for (let i = 0; i <= maze.width; i++) {
    for (let j = 0; j <= maze.height; j++) {
      posts.push(`M${i - POST / 2} ${j - POST / 2}h${POST}v${POST}h${-POST}z`);
    }
  }

  return {
    walls: walls.join(''),
    unknown: unknown.join(''),
    explored: explored.join(''),
    posts: posts.join(''),
    wallCount,
    exploredCount: explored.length,
  };
}

function labelled(index: number, last: number, current: number | null): boolean {
  return index % LABEL_EVERY === 0 || index === last || index === current;
}

/**
 * The maze as Micras knows it: walls solid, walls it has not seen dashed, the cells whose four
 * walls are known shaded, the goal outlined and the robot at its pose when the pose is streamed.
 * It keeps its cells square and fills the window.
 */
export function MazeView({ value: maze, roles }: TypeViewProps<Maze>) {
  const titleId = useId();
  const paths = mazePaths(maze);
  const pose = gridPose(roles);
  const cell = pose === null ? null : { x: gridIndex(pose.x), y: gridIndex(pose.y) };
  const inside = cell !== null && maze.contains(cell.x, cell.y);
  const top = (y: number) => maze.height - 1 - y;
  const goalXs = maze.goal.map((goal) => goal.x);
  const goalYs = maze.goal.map((goal) => goal.y);
  const goalLeft = Math.min(...goalXs);
  const goalTop = top(Math.max(...goalYs));
  const goalWidth = Math.max(...goalXs) - goalLeft + 1;
  const goalHeight = Math.max(...goalYs) - Math.min(...goalYs) + 1;
  const viewBox = [
    -MARGIN_LEFT,
    -MARGIN_EDGE,
    maze.width + MARGIN_LEFT + MARGIN_EDGE,
    maze.height + MARGIN_BOTTOM + MARGIN_EDGE,
  ].join(' ');

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <svg
        aria-labelledby={titleId}
        data-maze
        data-walls={paths.wallCount}
        data-explored={paths.exploredCount}
        data-robot-cell={inside ? `${cell.x},${cell.y}` : undefined}
        data-pose-x={roles?.['pose.x']}
        data-pose-y={roles?.['pose.y']}
        viewBox={viewBox}
        preserveAspectRatio="xMidYMid meet"
        className="min-h-0 w-full flex-1"
      >
        <title id={titleId}>
          {`Maze, ${maze.width} by ${maze.height}, ${paths.exploredCount} ${paths.exploredCount === 1 ? 'cell' : 'cells'} explored`}
        </title>
        <path d={paths.explored} className="fill-foreground/7" />
        {maze.goal.map((goal) => (
          <rect
            key={`${goal.x},${goal.y}`}
            x={goal.x}
            y={top(goal.y)}
            width={1}
            height={1}
            className="fill-chart-2/20"
          />
        ))}
        <rect
          x={goalLeft}
          y={goalTop}
          width={goalWidth}
          height={goalHeight}
          vectorEffect="non-scaling-stroke"
          className="fill-none stroke-chart-2/75"
          strokeWidth={1}
        />
        <path
          d={paths.unknown}
          vectorEffect="non-scaling-stroke"
          className="fill-none stroke-muted-foreground/35"
          strokeWidth={1}
          strokeDasharray="2 3"
        />
        <path
          d={paths.walls}
          vectorEffect="non-scaling-stroke"
          className="fill-none stroke-foreground"
          strokeWidth={2}
          strokeLinecap="square"
        />
        <path d={paths.posts} className="fill-foreground/50" />
        <text
          x={maze.start.x + 0.72}
          y={top(maze.start.y) + 0.72}
          textAnchor="middle"
          dominantBaseline="middle"
          className="fill-muted-foreground text-[0.4px] font-semibold"
        >
          S
        </text>
        <g className="font-mono text-[0.42px]">
          {Array.from({ length: maze.width }, (_, x) =>
            labelled(x, maze.width - 1, inside ? cell.x : null) ? (
              <text
                key={`x${x}`}
                x={x + 0.5}
                y={maze.height + 0.55}
                textAnchor="middle"
                dominantBaseline="middle"
                className={inside && cell.x === x ? 'fill-foreground' : 'fill-muted-foreground'}
              >
                {x}
              </text>
            ) : null
          )}
          {Array.from({ length: maze.height }, (_, y) =>
            labelled(y, maze.height - 1, inside ? cell.y : null) ? (
              <text
                key={`y${y}`}
                x={-0.35}
                y={top(y) + 0.5}
                textAnchor="end"
                dominantBaseline="middle"
                className={inside && cell.y === y ? 'fill-foreground' : 'fill-muted-foreground'}
              >
                {y}
              </text>
            ) : null
          )}
        </g>
        {pose === null ? null : (
          <polygon
            data-robot
            points="0.41,0 -0.29,0.3 -0.14,0 -0.29,-0.3"
            transform={`translate(${pose.x} ${maze.height - pose.y}) rotate(${(-pose.heading * 180) / Math.PI})`}
            vectorEffect="non-scaling-stroke"
            className="fill-primary stroke-card"
            strokeWidth={1.5}
            strokeLinejoin="round"
          />
        )}
      </svg>
      <div className="flex flex-wrap items-center justify-center gap-x-3.5 gap-y-1 text-[11px] text-muted-foreground">
        {pose === null ? null : (
          <span className="mr-auto font-mono text-foreground tabular-nums">
            {inside ? `cell ${cell.x},${cell.y}` : 'off the maze'} · {headingName(pose.heading)}
          </span>
        )}
        <Legend swatch="size-2.5 rounded-[2px] bg-foreground/10">explored</Legend>
        <Legend swatch="w-3.5 border-t border-dashed border-muted-foreground">unknown</Legend>
        <Legend swatch="h-0.5 w-3.5 bg-foreground">wall</Legend>
        <Legend swatch="size-2.5 rounded-[2px] border border-chart-2 bg-chart-2/20">goal</Legend>
      </div>
    </div>
  );
}

function Legend({ swatch, children }: { readonly swatch: string; readonly children: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <i className={`inline-block shrink-0 ${swatch}`} />
      {children}
    </span>
  );
}
