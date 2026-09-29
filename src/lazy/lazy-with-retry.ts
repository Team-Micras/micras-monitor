/**
 * Code-split components whose load can be tried again. `React.lazy` keeps the rejected import
 * forever, so a chunk that failed once would fail until the page reloads; these make a fresh
 * `import()` after `retryFailedLoads`.
 *
 * @module
 */

import { createElement, lazy, type ComponentProps, type ComponentType } from 'react';

/** A component loaded on first render. */
export interface LazyWithRetry<C extends ComponentType<any>> {
  readonly Component: ComponentType<ComponentProps<C>>;
  /** Starts loading the code without rendering, ignoring a failure. */
  readonly prefetch: () => Promise<void>;
  /** Whether the last load failed and no retry has replaced it yet. */
  readonly failed: () => boolean;
  /** Discards a failed load so that the next render imports the code again. */
  readonly retry: () => void;
}

const loaders = new Set<Pick<LazyWithRetry<ComponentType<any>>, 'prefetch' | 'retry'>>();

/**
 * Declares a component whose code loads on first render.
 *
 * @param load Imports the component's module, such as `() => import('./view')`.
 */
export function lazyWithRetry<C extends ComponentType<any>>(
  load: () => Promise<{ readonly default: C }>
): LazyWithRetry<C> {
  let failed = false;
  const create = () =>
    lazy(() =>
      load().catch((error: unknown) => {
        failed = true;
        throw error;
      })
    );
  let current = create();

  const Component = (props: ComponentProps<C>) => {
    'use no memo';
    return createElement(current, props);
  };

  const loader: LazyWithRetry<C> = {
    Component,
    prefetch: () =>
      load().then(
        () => undefined,
        () => undefined
      ),
    failed: () => failed,
    retry: () => {
      if (failed) {
        failed = false;
        current = create();
      }
    },
  };
  loaders.add(loader);
  return loader;
}

/** Discards every failed load, so that the components that render next import their code again. */
export function retryFailedLoads(): void {
  for (const loader of loaders) {
    loader.retry();
  }
}

/** Starts loading the code of every component declared so far. */
export function prefetchAll(): Promise<void> {
  return Promise.all([...loaders].map((loader) => loader.prefetch())).then(() => undefined);
}
