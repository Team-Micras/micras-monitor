import type { Scheduler } from '@/telemetry';

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
