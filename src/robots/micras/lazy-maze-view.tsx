import { Suspense } from 'react';

import type { TypeViewProps } from '@/core/robot';
import { lazyWithRetry } from '@/ui/lazy/lazy-with-retry';

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
