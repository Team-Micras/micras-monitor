/**
 * When the store tells its readers that something changed.
 *
 * The application hands the store a scheduler backed by `requestAnimationFrame`, so that however
 * many samples arrive between two frames, each reader hears about them once. Tests give it one that ticks only when they say so.
 */
export interface Scheduler {
  /**
   * Run a task once, on the next tick.
   *
   * @param task What to run.
   */
  schedule(task: () => void): void;
}
