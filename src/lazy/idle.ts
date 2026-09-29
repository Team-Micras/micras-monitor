/**
 * Runs a task once the browser is idle, or shortly after where it has no idle callback.
 *
 * @param task The task.
 * @returns What cancels it.
 */
export function whenIdle(task: () => void): () => void {
  if (typeof requestIdleCallback === 'function') {
    const handle = requestIdleCallback(task);
    return () => cancelIdleCallback(handle);
  }

  const timer = setTimeout(task, 200);
  return () => clearTimeout(timer);
}
