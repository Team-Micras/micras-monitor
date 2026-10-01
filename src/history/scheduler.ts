/**
 * When the store tells its readers that something changed.
 *
 * The application hands the store a scheduler backed by `requestAnimationFrame`, so that however
 * many samples arrive between two frames, each reader hears about them once. Tests give it one
 * that ticks only when they say so.
 */
export interface Scheduler {
  /**
   * Run a task once, on the next tick.
   *
   * @param task What to run.
   */
  schedule(task: () => void): void;
}

/**
 * A scheduler whose ticks happen only when {@link ManualScheduler.flush} is called.
 */
export class ManualScheduler implements Scheduler {
  private tasks: (() => void)[] = [];

  /** How many tasks are waiting for the next tick. */
  get pending(): number {
    return this.tasks.length;
  }

  /** {@inheritDoc Scheduler.schedule} */
  schedule(task: () => void): void {
    this.tasks.push(task);
  }

  /**
   * Run one tick: every task scheduled so far. Tasks those tasks schedule wait for the next tick.
   */
  flush(): void {
    const tasks = this.tasks;
    this.tasks = [];

    for (const task of tasks) {
      task();
    }
  }
}
