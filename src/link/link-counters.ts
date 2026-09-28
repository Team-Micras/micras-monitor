import type { LinkStats } from './session-types';

type Counter = { [K in keyof LinkStats]: LinkStats[K] extends number ? K : never }[keyof LinkStats];

/**
 * The counters of a link, and a snapshot of them that stays the same object until one changes, so
 * that a view reading it on every render only renders again when something did change.
 */
export class LinkCounters {
  private readonly values: { -readonly [K in keyof LinkStats]: LinkStats[K] } = {
    bytesIn: 0,
    bytesOut: 0,
    framesIn: 0,
    framesDiscarded: 0,
    framesUndecodable: 0,
    creditReturned: 0,
    rttMs: null,
    samples: 0,
    droppedSamples: 0,
    handshakes: 0,
    clockResets: 0,
  };
  private frozen: LinkStats | null = null;

  /** The counters as they are now. */
  get snapshot(): LinkStats {
    this.frozen ??= Object.freeze({ ...this.values });
    return this.frozen;
  }

  /** Add to a counter. */
  add(counter: Counter, amount = 1): void {
    if (amount !== 0) {
      this.values[counter] += amount;
      this.frozen = null;
    }
  }

  /** Set a value that is measured rather than counted. */
  set<K extends 'rttMs' | 'clockResets'>(key: K, value: LinkStats[K]): void {
    if (this.values[key] !== value) {
      this.values[key] = value;
      this.frozen = null;
    }
  }
}
