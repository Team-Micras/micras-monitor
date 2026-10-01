import { Cobs, CREDIT_WINDOW, MessageType } from '../wire';
import { creditPayload } from './messages';

/**
 * Whether the robot charges a frame type to the credit window. It charges what it sends on its
 * own initiative (`send_metered` in `link.cpp`); replies are bounded by the rate of the requests.
 */
export function isMetered(type: MessageType): boolean {
  return (
    type === MessageType.SAMPLE || type === MessageType.SCHEMA_PAGE || type === MessageType.LOG
  );
}

/**
 * How many bytes a frame took on the wire, delimiter included, which is what the robot charged
 * for it. Exact for every frame the protocol allows: COBS adds one byte per 254, and a frame is
 * at most 203 bytes before encoding.
 *
 * @param payloadLength The length of the payload, without the type and the frame check.
 */
export function wireSize(payloadLength: number): number {
  return Cobs.encodedSize(payloadLength + 3) + 1;
}

/** Credit to give back: the payload of a CREDIT, and how many bytes it gives back. */
export interface CreditGrant {
  readonly payload: Uint8Array;
  readonly bytes: number;
}

/** When `CreditLedger` gives credit back. */
export interface CreditLedgerOptions {
  /** Give back as soon as this many bytes are owed. */
  minBytes: number;

  /** Give back at most this long, in milliseconds, after the first byte owed. */
  maxDelayMs: number;
}

/** A CREDIT is 9 bytes on the wire, so one per 64 bytes received costs about a seventh of the uplink. */
export const DEFAULT_CREDIT_LEDGER: CreditLedgerOptions = { minBytes: 64, maxDelayMs: 10 };

const U32_RANGE = 2 ** 32;

/**
 * Protocol version 2's credit: every CREDIT carries the total of metered bytes consumed since
 * HELLO, wrapping at 2³², coalesced so that a stream of small samples does not become a stream of
 * CREDIT frames.
 *
 * A total, unlike a delta, loses nothing when a CREDIT is lost: the next one carries it. What a
 * total alone cannot recover is a metered frame that never arrived intact, which the robot charged
 * and the monitor never counted. The PONG closes that gap: it carries the total the robot sent
 * before it, so whatever of it did not arrive by then never will, and is given back as consumed.
 * The total is sent again after every PONG, lost bytes or not, because a CREDIT lost when nothing
 * else is owed would otherwise leave a robot whose window is full waiting for one forever.
 */
export class CreditLedger {
  private consumed = 0;
  private told = 0;
  private owedSince: number | null = null;
  private repeat = false;

  /**
   * @param options When to give credit back.
   * @param window The robot's credit window, which no loss can be larger than, until a reset
   * gives the one the robot announced.
   */
  constructor(
    private readonly options: CreditLedgerOptions = DEFAULT_CREDIT_LEDGER,
    private window: number = CREDIT_WINDOW
  ) {}

  /**
   * Count a metered frame that arrived intact.
   *
   * @param bytes Its size on the wire.
   * @param now The current time, in milliseconds.
   */
  received(bytes: number, now: number): void {
    this.consumed = (this.consumed + bytes) % U32_RANGE;
    this.owedSince ??= now;
  }

  /**
   * Take the robot's own count of the metered bytes it sent before a PONG as everything consumed,
   * since whatever of it has not arrived intact by the PONG never will, and say the total again.
   *
   * @param sentTotal The robot's cumulative total, wrapping at 2³².
   * @param now The current time, in milliseconds.
   * @returns The bytes lost on the way that it gives back, or null when the total is not one the
   * robot could have sent since the handshake, which only a robot that started over sends.
   */
  resync(sentTotal: number, now: number): number | null {
    const lost = distance(this.consumed, sentTotal);

    if (lost > this.window) {
      return null;
    }

    this.consumed = sentTotal;
    this.repeat = this.consumed !== 0;
    this.owedSince = this.repeat ? now - this.options.maxDelayMs : null;
    return lost;
  }

  /**
   * Take the credit due now, if any.
   *
   * @param now The current time, in milliseconds.
   * @returns What to send, or null when nothing is due.
   */
  take(now: number): CreditGrant | null {
    const owed = distance(this.told, this.consumed);

    if ((owed === 0 && !this.repeat) || this.owedSince === null) {
      return null;
    }

    if (owed < this.options.minBytes && now - this.owedSince < this.options.maxDelayMs) {
      return null;
    }

    this.told = this.consumed;
    this.owedSince = null;
    this.repeat = false;
    return { payload: creditPayload(this.consumed), bytes: owed };
  }

  /** When credit will be due without anything else arriving, or null when nothing is owed. */
  dueAt(): number | null {
    return this.owedSince === null ? null : this.owedSince + this.options.maxDelayMs;
  }

  /**
   * Start over from zero, because a HELLO reset the robot's window.
   *
   * @param window The window the robot announced in its HELLO_ACK, when known; the one before
   * otherwise.
   */
  reset(window = this.window): void {
    this.window = window;
    this.consumed = 0;
    this.told = 0;
    this.owedSince = null;
    this.repeat = false;
  }
}

/** How far a u32 total has to go forward, wrapping, to reach another. */
export function distance(from: number, to: number): number {
  return (to - from + U32_RANGE) % U32_RANGE;
}
