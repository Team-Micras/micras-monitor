import { lazyWithRetry } from '@/lazy/lazy-with-retry';

/** The Ctrl+K launcher, loaded when it is first opened. */
export const LazyLauncher = lazyWithRetry(() =>
  import('./launcher').then((module) => ({ default: module.Launcher }))
).Component;

/** The variables drawer, loaded when it is first opened. */
export const LazyVariableDrawer = lazyWithRetry(() =>
  import('./variable-drawer').then((module) => ({ default: module.VariableDrawer }))
).Component;
