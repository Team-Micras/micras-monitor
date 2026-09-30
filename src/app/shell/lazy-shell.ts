import { lazyWithRetry } from '@/lazy/lazy-with-retry';

/** The Ctrl+K launcher, loaded when it is first opened. */
export const LazyLauncher = lazyWithRetry(() =>
  import('./launcher').then((module) => ({ default: module.Launcher }))
).Component;

/** The variables drawer, loaded when it is first opened. */
export const LazyVariableDrawer = lazyWithRetry(() =>
  import('./variable-drawer').then((module) => ({ default: module.VariableDrawer }))
).Component;

/** The question of what becomes of a closing workspace's windows, loaded when first asked. */
export const LazyCloseWorkspaceDialog = lazyWithRetry(() =>
  import('./close-workspace-dialog').then((module) => ({ default: module.CloseWorkspaceDialog }))
).Component;

/** The undo notices, loaded when something is first removed. */
export const LazyUndoNotices = lazyWithRetry(() =>
  import('./undo-notices').then((module) => ({ default: module.UndoNotices }))
).Component;
