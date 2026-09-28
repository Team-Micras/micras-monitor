const U32_RANGE = 2 ** 32;

/**
 * How close to the ends of the u32 range two timestamps must be for a step back to be read as the
 * counter wrapping: a minute, far longer than any gap between two samples of a live stream and
 * far shorter than the 71.6 minutes the counter takes to go around.
 */
export const DEFAULT_WRAP_WINDOW_US = 60_000_000;

/**
 * Turns the robot's u32 microsecond timestamps into a time that keeps growing past the 71.6
 * minutes the counter takes to wrap.
 *
 * A step back is a wrap only when the previous value was near the top of the range and the new
 * one is near zero. Any other step back is the robot's clock starting over, such as after a reset,
 * and the time starts over with it instead of jumping ahead by a whole wrap.
 */
export class TimestampUnwrapper {
  private previous: number | null = null;
  private wraps = 0;
  private restarts = 0;

  constructor(private readonly windowUs: number = DEFAULT_WRAP_WINDOW_US) {}

  /**
   * @param timestampUs The timestamp as the robot sent it.
   * @returns The time in microseconds since the robot's clock last started.
   */
  unwrap(timestampUs: number): number {
    if (this.previous !== null && timestampUs < this.previous) {
      if (this.isWrap(this.previous, timestampUs)) {
        this.wraps++;
      } else {
        this.wraps = 0;
        this.restarts++;
      }
    }

    this.previous = timestampUs;
    return this.wraps * U32_RANGE + timestampUs;
  }

  /** How many times the robot's clock was seen starting over. */
  get resets(): number {
    return this.restarts;
  }

  private isWrap(previous: number, next: number): boolean {
    return previous >= U32_RANGE - this.windowUs && next < this.windowUs;
  }
}
