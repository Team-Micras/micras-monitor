import { lazy, Suspense } from 'react';

import type { TypeViewProps } from '@/robot-kit';

import type { Maze } from './maze';

const MazeView = lazy(() => import('./maze-view').then((module) => ({ default: module.MazeView })));

/** The maze view, whose code loads with the first maze drawn. */
export function LazyMazeView(props: TypeViewProps<Maze>) {
  return (
    <Suspense fallback={null}>
      <MazeView {...props} />
    </Suspense>
  );
}
