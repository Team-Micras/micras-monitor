/**
 * One timeline for everything a monitor session stores, across reboots of the robot, resets of
 * its clock and reconnections.
 *
 * @module
 */

/**
 * Places the robot's times on the session timeline. Each run of the robot's clock, a link
 * timeline, gets an offset the first time one of its times is placed: none for the very first,
 * and for later ones whatever puts it after the latest time placed by as long as passed on the
 * host, so the timeline never goes back and its gaps last as long as they did.
 */
export class SessionTimeline {
  readonly #now: () => number;
  #offsets = new Map<number, number>();
  #lastUs = Number.NEGATIVE_INFINITY;
  #lastHostMs = 0;

  /**
   * @param now The host's clock in milliseconds; `performance.now` by default.
   */
  constructor(now: () => number = () => performance.now()) {
    this.#now = now;
  }

  /** The latest time placed, or -Infinity before any. */
  get lastUs(): number {
    return this.#lastUs;
  }

  /**
   * Place a time of the robot's.
   *
   * @param timeline The run of the robot's clock it belongs to, as the session numbers them.
   * @param robotUs The robot's time, in microseconds, unwrapped.
   * @returns The time on the session timeline.
   */
  place(timeline: number, robotUs: number): number {
    const hostMs = this.#now();
    let offset = this.#offsets.get(timeline);

    if (offset === undefined) {
      offset = Number.isFinite(this.#lastUs)
        ? this.#lastUs + Math.max(1, (hostMs - this.#lastHostMs) * 1000) - robotUs
        : 0;
      this.#offsets.set(timeline, offset);
    }

    const timeUs = robotUs + offset;

    if (timeUs > this.#lastUs) {
      this.#lastUs = timeUs;
      this.#lastHostMs = hostMs;
    }

    return timeUs;
  }

  /** Start numbering timelines over, as a new session does, keeping the times placed so far. */
  rebase(): void {
    this.#offsets = new Map();
  }
}
