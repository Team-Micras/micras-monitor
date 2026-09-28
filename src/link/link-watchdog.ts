import { encodePing } from './messages';
import type { PendingRequests } from './requests';
import type { SessionTiming } from './session-types';

/** What the watchdog needs from the session. */
export interface LinkWatchdogHost {
  /** Send a frame to the robot. */
  send(frame: Uint8Array): void;

  /** Where PINGs wait for their PONG. */
  readonly requests: PendingRequests;

  readonly timing: SessionTiming;

  /**
   * How long a period of the fastest group streaming is, in milliseconds, or null when nothing
   * is supposed to be streaming.
   */
  streamingPeriodMs(): number | null;

  /** A PONG came back; how long its PING took, in milliseconds. */
  answered(roundTripMs: number): void;

  /** The robot has sent nothing intact for too long. */
  silent(): void;

  /** Groups are streaming but no sample arrived for too long. */
  stalled(): void;
}

/**
 * Keeps an eye on a link that looks up: PINGs the robot so that silence is noticed and the round
 * trip measured, and notices a stream that stopped.
 *
 * Silence is nothing intact arriving at all, so a PONG lost on the way costs nothing while
 * anything else still arrives. A stall is samples stopping while groups are enabled, which PONGs
 * cannot hide. A PING waits for its PONG for one interval, so there is never more than one out.
 */
export class LinkWatchdog {
  private timer: ReturnType<typeof setInterval> | undefined;
  private lastHeardAt = 0;
  private lastSampleAt = 0;
  private lastPingAt = Number.NEGATIVE_INFINITY;

  constructor(private readonly host: LinkWatchdogHost) {}

  /**
   * Start watching, as the handshake completes.
   *
   * @param now The current time, in milliseconds.
   */
  start(now: number): void {
    this.stop();
    this.lastHeardAt = now;
    this.lastSampleAt = now;
    this.lastPingAt = Number.NEGATIVE_INFINITY;
    this.timer = setInterval(() => this.check(performance.now()), this.checkIntervalMs());
  }

  /** Stop watching. */
  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Something intact arrived. */
  heard(now: number): void {
    this.lastHeardAt = now;
  }

  /** A sample arrived, or a group started streaming. */
  sampled(now: number): void {
    this.lastSampleAt = now;
  }

  private checkIntervalMs(): number {
    const { pingIntervalMs, minStallMs } = this.host.timing;
    return Math.max(10, Math.min(pingIntervalMs, minStallMs / 4));
  }

  private check(now: number): void {
    if (now - this.lastHeardAt > this.host.timing.silenceTimeoutMs) {
      this.host.silent();
    } else if (this.isStalled(now)) {
      this.host.stalled();
    } else if (
      !this.host.requests.has('ping') &&
      now - this.lastPingAt >= this.host.timing.pingIntervalMs
    ) {
      this.ping(now);
    }
  }

  private isStalled(now: number): boolean {
    const periodMs = this.host.streamingPeriodMs();

    if (periodMs === null) {
      return false;
    }

    const { minStallMs, stallPeriods } = this.host.timing;
    return now - this.lastSampleAt > Math.max(minStallMs, stallPeriods * periodMs);
  }

  private ping(sentAt: number): void {
    const answer = this.host.requests.add('ping', 0, this.host.timing.pingIntervalMs);

    this.lastPingAt = sentAt;
    this.host.send(encodePing());
    answer.then(
      () => this.host.answered(performance.now() - sentAt),
      () => undefined
    );
  }
}
