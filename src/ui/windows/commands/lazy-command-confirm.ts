import { lazyWithRetry } from '../../lazy/lazy-with-retry';

/** The dialog that asks before a dangerous command, loaded when the first one is asked. */
export const LazyCommandConfirm = lazyWithRetry(() =>
  import('./command-confirm').then((module) => ({ default: module.CommandConfirm }))
).Component;
