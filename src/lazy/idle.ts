/** How long the browser may keep a task waiting for idle time: 2 s. */
export const IDLE_TIMEOUT_MS = 2000;

/**
 * Runs a task once the browser is idle, or shortly after where it has no idle callback. A busy
 * browser runs it after {@link IDLE_TIMEOUT_MS} at the latest.
 *
 * @param task The task.
 * @returns What cancels it.
 */
export function whenIdle(task: () => void): () => void {
  if (typeof requestIdleCallback === 'function') {
    const handle = requestIdleCallback(task, { timeout: IDLE_TIMEOUT_MS });
    return () => cancelIdleCallback(handle);
  }

  const timer = setTimeout(task, 200);
  return () => clearTimeout(timer);
}

/**
 * Loads code once the browser is idle and hands it to `use`.
 *
 * @param load Imports the module, such as `() => import('./view')`.
 * @param use Receives the loaded module.
 * @param onError Told when the load failed, so that the user can be told and try again.
 * @returns What cancels the load if it has not started.
 */
export function importWhenIdle<M>(
  load: () => Promise<M>,
  use: (module: M) => void,
  onError: (error: unknown) => void
): () => void {
  return whenIdle(() => {
    load().then(use, onError);
  });
}
