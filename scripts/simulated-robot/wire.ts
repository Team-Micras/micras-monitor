import { Cobs } from '../../src/sources/micras-comm/wire';
import { seededRandom, type FaultOptions, type RobotStats } from './faults';

interface InFlight {
  bytes: Uint8Array;
  /** When its air time ends, which is when it leaves the radio's buffer. */
  airDoneAt: number;
  dueAt: number;
}

/**
 * The radio between the robot and the monitor: it carries bytes both ways with the configured
 * throughput, latency, jitter and stalls, and corrupts outgoing frames at the configured rate.
 *
 * Without limits it hands bytes over at once. With them, bytes wait in a queue that stands in for
 * the radio module's buffer and leave when the air time before them is spent; a frame that finds
 * the buffer full is dropped whole, and the robot is not told.
 */
export class Wire {
  private readonly random: () => number;
  private readonly jitter: () => number;
  private readonly outgoing: InFlight[] = [];
  private readonly incoming: InFlight[] = [];
  private busyUntil = 0;
  private outgoingDue = 0;
  private incomingDue = 0;
  private readonly startedAt = performance.now();

  /**
   * @param faults What to do to the bytes.
   * @param stats Where to count what was done.
   * @param toMonitor Hands bytes to the monitor.
   * @param toRobot Hands bytes to the robot.
   */
  constructor(
    private readonly faults: FaultOptions,
    private readonly stats: RobotStats,
    private readonly toMonitor: (bytes: Uint8Array) => void,
    private readonly toRobot: (bytes: Uint8Array) => void
  ) {
    this.random = seededRandom(faults.seed);
    this.jitter = seededRandom(faults.seed + 1);
  }

  /** Send one frame from the robot. */
  send(frame: Uint8Array, metered: boolean): void {
    const bytes = this.maybeCorrupt(frame, metered);

    if (!this.isShaped()) {
      this.toMonitor(bytes);
      return;
    }

    const now = performance.now();

    if (this.buffered(now) + bytes.length > this.faults.radioBufferBytes) {
      this.stats.radioOverflowBytes += bytes.length;
      return;
    }

    const airTimeMs =
      this.faults.throughputBytesPerSecond > 0
        ? (bytes.length * 1000) / this.faults.throughputBytesPerSecond
        : 0;

    this.busyUntil = Math.max(now, this.busyUntil) + airTimeMs;
    this.outgoingDue = Math.max(this.outgoingDue, this.afterStall(this.busyUntil + this.delay()));
    this.outgoing.push({ bytes, airDoneAt: this.busyUntil, dueAt: this.outgoingDue });
  }

  /** Take bytes the monitor sent. */
  receive(bytes: Uint8Array): void {
    if (!this.delays()) {
      this.toRobot(bytes);
      return;
    }

    const now = performance.now();
    this.incomingDue = Math.max(this.incomingDue, this.afterStall(now + this.delay()));
    this.incoming.push({ bytes, airDoneAt: now, dueAt: this.incomingDue });
  }

  /** Deliver whatever is due by now, both ways. */
  flush(): void {
    const now = performance.now();
    const due = takeDue(this.outgoing, now);

    if (due.length > 0) {
      this.toMonitor(concat(due));
    }

    takeDue(this.incoming, now).forEach((bytes) => this.toRobot(bytes));
  }

  private buffered(now: number): number {
    return this.outgoing
      .filter((flight) => flight.airDoneAt > now)
      .reduce((total, flight) => total + flight.bytes.length, 0);
  }

  private isShaped(): boolean {
    return this.faults.throughputBytesPerSecond > 0 || this.delays();
  }

  private delays(): boolean {
    return this.faults.latencyMs > 0 || this.faults.jitterMs > 0 || this.stalls();
  }

  private stalls(): boolean {
    return this.faults.stallMs > 0 && this.faults.stallEveryMs > 0;
  }

  /** When bytes due at a moment arrive, once the stall the moment falls in, if any, is over. */
  private afterStall(at: number): number {
    if (!this.stalls()) {
      return at;
    }

    const into = (at - this.startedAt) % this.faults.stallEveryMs;
    return into < this.faults.stallMs ? at + this.faults.stallMs - into : at;
  }

  private delay(): number {
    return (
      this.faults.latencyMs + (this.faults.jitterMs > 0 ? this.jitter() * this.faults.jitterMs : 0)
    );
  }

  private maybeCorrupt(frame: Uint8Array, metered: boolean): Uint8Array {
    if (this.faults.corruptRate <= 0 || this.random() >= this.faults.corruptRate) {
      return frame;
    }

    this.stats.corruptedFrames++;

    if (metered) {
      this.stats.corruptedMeteredBytes += frame.length;
    }

    return breakFrameCheck(frame);
  }
}

/**
 * Flip a bit of the frame check of an encoded frame, which keeps its length and its framing
 * intact and is certain to fail the check on the other end.
 */
function breakFrameCheck(frame: Uint8Array): Uint8Array {
  const plain = Cobs.decode(frame.subarray(0, frame.length - 1));

  if (!plain) {
    return frame;
  }

  const broken = plain.slice();
  broken[broken.length - 1] ^= 0x01;

  const encoded = Cobs.encode(broken);
  const result = new Uint8Array(encoded.length + 1);
  result.set(encoded);
  result[encoded.length] = Cobs.DELIMITER;
  return result;
}

function takeDue(queue: InFlight[], now: number): Uint8Array[] {
  const due: Uint8Array[] = [];

  while (queue.length > 0 && queue[0].dueAt <= now) {
    due.push(queue[0].bytes);
    queue.shift();
  }

  return due;
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
  let offset = 0;

  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }

  return result;
}
