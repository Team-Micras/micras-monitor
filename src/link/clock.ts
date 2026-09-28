const U32_RANGE = 2 ** 32;

/**
 * How much further the robot's clock may have run than the host's did, in microseconds, when a
 * step back is read as the counter wrapping: the two clocks drift, the simulation runs slower than
 * real time, and a timestamp is taken a transport's latency before it is read.
 */
export const DEFAULT_WRAP_SLACK_US = 5_000_000;

/**
 * Turns the robot's u32 microsecond timestamps into a time that keeps growing past the 71.6
 * minutes the counter takes to wrap.
 *
 * A step back is a wrap only when going forward around the range to the new value is no more
 * than the host's own clock ran since the previous one, with some slack. That tells a wrap from a
 * reset however long the gap between the two timestamps was. Any other step back is the robot's
 * clock starting over, and the time starts over with it instead of jumping ahead by a whole wrap.
 */
export class TimestampUnwrapper {
  private previous: { timestampUs: number; hostMs: number } | null = null;
  private wraps = 0;
  private restarts = 0;

  constructor(private readonly slackUs: number = DEFAULT_WRAP_SLACK_US) {}

  /**
   * @param timestampUs The timestamp as the robot sent it.
   * @param hostMs When it arrived, in milliseconds of a monotonic host clock.
   * @returns The time in microseconds since the robot's clock last started.
   */
  unwrap(timestampUs: number, hostMs: number): number {
    const previous = this.previous;

    if (previous && timestampUs < previous.timestampUs) {
      if (this.isWrap(previous.timestampUs, timestampUs, (hostMs - previous.hostMs) * 1000)) {
        this.wraps++;
      } else {
        this.wraps = 0;
        this.restarts++;
      }
    }

    this.previous = { timestampUs, hostMs };
    return this.wraps * U32_RANGE + timestampUs;
  }

  /**
   * Place a timestamp on the time the samples are on, without taking it as the latest: the one
   * closest to the latest sample, either side of a wrap. That suits what the robot stamps on the
   * clock of the samples but may send out of order with them, such as a LOG held for credit.
   *
   * @param timestampUs The timestamp as the robot sent it.
   * @returns The time in microseconds since the robot's clock last started.
   */
  place(timestampUs: number): number {
    if (!this.previous) {
      return timestampUs;
    }

    const base = this.wraps * U32_RANGE;
    const latest = base + this.previous.timestampUs;

    return [base - U32_RANGE, base, base + U32_RANGE]
      .map((wrap) => wrap + timestampUs)
      .filter((time) => time >= 0)
      .reduce((best, time) => (Math.abs(time - latest) < Math.abs(best - latest) ? time : best));
  }

  /**
   * Forget the robot's clock, because it is known to have started over, such as after a reboot
   * the handshake revealed. This is not counted as a reset seen in the timestamps.
   */
  reset(): void {
    this.previous = null;
    this.wraps = 0;
  }

  /** How many times the timestamps showed the robot's clock starting over. */
  get resets(): number {
    return this.restarts;
  }

  private isWrap(previousUs: number, nextUs: number, hostElapsedUs: number): boolean {
    return nextUs + U32_RANGE - previousUs <= hostElapsedUs + this.slackUs;
  }
}
