import { Suspense } from 'react';

import { lazyWithRetry } from '@/lazy/lazy-with-retry';
import type { TypeViewProps } from '@/robot-kit';

import type { Maze } from './maze';

const MazeView = lazyWithRetry(() =>
  import('./maze-view').then((module) => ({ default: module.MazeView }))
).Component;

/** The maze view, whose code loads with the first maze drawn. */
export function LazyMazeView(props: TypeViewProps<Maze>) {
  return (
    <Suspense fallback={null}>
      <MazeView {...props} />
    </Suspense>
  );
}
