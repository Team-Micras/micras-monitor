import type { HandshakeReason, LinkContext } from './link-events';
import { encodePing } from './messages';

/**
 * Keeps an eye on a link that looks up: PINGs the robot so that silence is noticed and the round
 * trip measured, and notices a stream that stopped.
 *
 * Silence is nothing intact arriving at all, so a PONG lost on the way costs nothing while
 * anything else still arrives. A stall is samples stopping while groups are enabled, which PONGs
 * cannot hide; a stream that goes quiet for half as long gets a PING early, since its PONG may
 * recover the credit that stopped it. A PING waits for its PONG for one interval, so there is
 * never more than one out.
 */
export class LinkWatchdog {
  readonly #context: LinkContext;
  readonly #streamingPeriodMs: () => number | null;
  readonly #alarm: (reason: Extract<HandshakeReason, 'keepalive' | 'stall'>) => void;
  #timer: ReturnType<typeof setInterval> | undefined;
  #lastHeardAt = 0;
  #lastSampleAt = 0;
  #lastPingAt = Number.NEGATIVE_INFINITY;

  /**
   * @param context What the watchdog shares with its link.
   * @param streamingPeriodMs How long a period of the fastest group streaming is, in
   *   milliseconds, or null when nothing is supposed to be streaming.
   * @param alarm Told `keepalive` when the robot has sent nothing intact for too long, and
   *   `stall` when groups are streaming but no sample arrived for too long.
   */
  constructor(
    context: LinkContext,
    streamingPeriodMs: () => number | null,
    alarm: (reason: Extract<HandshakeReason, 'keepalive' | 'stall'>) => void
  ) {
    this.#context = context;
    this.#streamingPeriodMs = streamingPeriodMs;
    this.#alarm = alarm;
  }

  /**
   * Start watching, as the handshake completes.
   *
   * @param now The current time, in milliseconds.
   */
  start(now: number): void {
    this.stop();
    this.#lastHeardAt = now;
    this.#lastSampleAt = now;
    this.#lastPingAt = Number.NEGATIVE_INFINITY;
    this.#timer = setInterval(() => this.#check(performance.now()), this.#checkIntervalMs());
  }

  /** Stop watching. */
  stop(): void {
    clearInterval(this.#timer);
    this.#timer = undefined;
  }

  /** Something intact arrived. */
  heard(now: number): void {
    this.#lastHeardAt = now;
  }

  /** A sample arrived, or a group started streaming. */
  sampled(now: number): void {
    this.#lastSampleAt = now;
  }

  #checkIntervalMs(): number {
    const { pingIntervalMs, minStallMs } = this.#context.timing;
    return Math.max(10, Math.min(pingIntervalMs, minStallMs / 4));
  }

  #check(now: number): void {
    const stallMs = this.#stallThresholdMs();
    const quietMs = now - this.#lastSampleAt;

    if (now - this.#lastHeardAt > this.#context.timing.silenceTimeoutMs) {
      this.#alarm('keepalive');
    } else if (stallMs !== null && quietMs > stallMs) {
      this.#alarm('stall');
    } else if (!this.#context.requests.has('ping') && this.#pingDue(now, stallMs, quietMs)) {
      this.#ping(now);
    }
  }

  /**
   * A PING is due every interval, and early once samples have stopped for half the stall
   * threshold without one sent since: its PONG gives back credit lost with corrupted frames,
   * which usually restarts the stream before the stall has to redo the handshake.
   */
  #pingDue(now: number, stallMs: number | null, quietMs: number): boolean {
    if (now - this.#lastPingAt >= this.#context.timing.pingIntervalMs) {
      return true;
    }

    if (stallMs === null) {
      return false;
    }

    const suspiciousMs = stallMs / 2;
    return quietMs > suspiciousMs && this.#lastPingAt < this.#lastSampleAt + suspiciousMs;
  }

  #stallThresholdMs(): number | null {
    const periodMs = this.#streamingPeriodMs();

    if (periodMs === null) {
      return null;
    }

    const { minStallMs, stallPeriods } = this.#context.timing;
    return Math.max(minStallMs, stallPeriods * periodMs);
  }

  #ping(sentAt: number): void {
    const answer = this.#context.requests.add('ping', 0, this.#context.timing.pingIntervalMs);

    this.#lastPingAt = sentAt;
    this.#context.send(encodePing());
    answer.then(
      () => this.#context.counters.set('rttMs', performance.now() - sentAt),
      () => undefined
    );
  }
}
