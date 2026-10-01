/**
 * Runs tasks one at a time: a task given while another runs waits until that one settles. A task
 * given while none runs starts at once, in the same call, so a request it sends goes out before
 * the caller does anything else.
 *
 * The session uses it for requests whose ERROR could be taken for another's, which only waiting
 * can tell apart.
 */
export class AsyncMutex {
  private running: Promise<void> | null = null;

  /**
   * Run a task once no other one runs.
   *
   * @param task Starts the work and returns its promise.
   * @returns What the task settled with.
   */
  async run<T>(task: () => Promise<T>): Promise<T> {
    while (this.running) {
      await this.running;
    }

    const work = task();
    const settled = work.then(
      () => undefined,
      () => undefined
    );

    this.running = settled;

    try {
      return await work;
    } finally {
      if (this.running === settled) {
        this.running = null;
      }
    }
  }
}
