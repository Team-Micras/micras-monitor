import { Cobs, MessageType } from '../protocol';
import { creditPayload, MAX_CREDIT_DELTA } from './messages';

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

/** Credit to give back: the payload of a CREDIT, and how many bytes it gives back. */
export interface CreditGrant {
  readonly payload: Uint8Array;
  readonly bytes: number;
}

/**
 * Decides when to give credit back and what the CREDIT says. The robot may only send metered
 * bytes it has credit for, because the radio module has no flow control and drops silently when
 * its buffer fills.
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
   * Take the robot's own count of the metered bytes it sent, which a PONG carries in protocol
   * versions that have it, as everything consumed.
   *
   * @param sentTotal The robot's cumulative total.
   * @param now The current time, in milliseconds.
   */
  resync(sentTotal: number, now: number): void;

  /**
   * Take the credit due now, if any.
   *
   * @param now The current time, in milliseconds.
   * @returns What to send, or null when nothing is due.
   */
  take(now: number): CreditGrant | null;

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
 *
 * A delta cannot recover what was lost. A metered frame that arrives corrupted, or not at all, was
 * charged by the robot and is never given back, and neither is a CREDIT lost on its way, so every
 * such loss narrows the window for the rest of the session until only a new HELLO opens it again.
 * The session sees that as a stall. Protocol version 2 replaces this with cumulative totals that a
 * later CREDIT and every PONG bring back into step.
 */
export class CoalescingCredit implements CreditPolicy {
  private owed = 0;
  private owedSince: number | null = null;

  constructor(private readonly options: CoalescingCreditOptions = DEFAULT_COALESCING) {}

  received(bytes: number, now: number): void {
    this.owed += bytes;
    this.owedSince ??= now;
  }

  /** Version 1's PONG carries no total, so there is nothing to take. */
  resync(): void {
    return;
  }

  take(now: number): CreditGrant | null {
    if (this.owed === 0 || this.owedSince === null) {
      return null;
    }

    if (this.owed < this.options.minBytes && now - this.owedSince < this.options.maxDelayMs) {
      return null;
    }

    const delta = Math.min(this.owed, MAX_CREDIT_DELTA);
    this.owed -= delta;
    this.owedSince = this.owed > 0 ? now : null;
    return { payload: creditPayload(delta), bytes: delta };
  }

  dueAt(): number | null {
    return this.owedSince === null ? null : this.owedSince + this.options.maxDelayMs;
  }

  reset(): void {
    this.owed = 0;
    this.owedSince = null;
  }
}
