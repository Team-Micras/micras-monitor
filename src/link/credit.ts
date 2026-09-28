import { Cobs, MessageType } from '../protocol';
import { MAX_CREDIT_DELTA } from './messages';

/**
 * Whether the robot charges a frame type to the credit window. It charges what it sends on its
 * own initiative (`send_metered` in `link.cpp`); replies are bounded by the rate of the requests.
 */
export function isMetered(type: MessageType): boolean {
  return type === MessageType.SAMPLE || type === MessageType.SCHEMA_PAGE;
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

/**
 * Decides when to give credit back and how much. The robot may only send metered bytes it has
 * credit for, because the radio module has no flow control and drops silently when its buffer
 * fills.
 */
export interface CreditPolicy {
  /**
   * Count a metered frame that arrived intact.
   *
   * @param bytes Its size on the wire.
   * @param now The current time, in milliseconds.
   */
  received(bytes: number, now: number): void;

  /**
   * Take the credit due now, if any.
   *
   * @param now The current time, in milliseconds.
   * @returns The value the CREDIT message carries, or null when none is due.
   */
  take(now: number): number | null;

  /** When credit will be due without anything else arriving, or null when nothing is owed. */
  dueAt(): number | null;

  /** Forget whatever is owed, because the robot reset its window. */
  reset(): void;
}

/** When `CoalescingCredit` gives credit back. */
export interface CoalescingCreditOptions {
  /** Give back as soon as this many bytes are owed. */
  minBytes: number;

  /** Give back at most this long, in milliseconds, after the first byte owed. */
  maxDelayMs: number;
}

/** A CREDIT is 7 bytes on the wire, so one per 64 bytes received costs about a tenth of the uplink. */
export const DEFAULT_COALESCING: CoalescingCreditOptions = { minBytes: 64, maxDelayMs: 10 };

/**
 * Protocol version 1's credit: a delta of the bytes received since the last CREDIT, coalesced so
 * that a stream of small samples does not become a stream of CREDIT frames.
 */
export class CoalescingCredit implements CreditPolicy {
  private owed = 0;
  private owedSince: number | null = null;

  constructor(private readonly options: CoalescingCreditOptions = DEFAULT_COALESCING) {}

  received(bytes: number, now: number): void {
    this.owed += bytes;
    this.owedSince ??= now;
  }

  take(now: number): number | null {
    if (this.owed === 0 || this.owedSince === null) {
      return null;
    }

    if (this.owed < this.options.minBytes && now - this.owedSince < this.options.maxDelayMs) {
      return null;
    }

    const delta = Math.min(this.owed, MAX_CREDIT_DELTA);
    this.owed -= delta;
    this.owedSince = this.owed > 0 ? now : null;
    return delta;
  }

  dueAt(): number | null {
    return this.owedSince === null ? null : this.owedSince + this.options.maxDelayMs;
  }

  reset(): void {
    this.owed = 0;
    this.owedSince = null;
  }
}
