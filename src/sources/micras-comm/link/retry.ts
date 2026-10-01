import { TimeoutError } from './errors';

/** How the wait between two reconnection attempts grows. */
export interface BackoffOptions {
  /** The wait before the first retry, in milliseconds. */
  initialMs: number;

  /** The longest wait, in milliseconds, no matter how many attempts failed. */
  maxMs: number;

  /** How much longer each wait is than the one before. */
  factor: number;
}

/**
 * Quick at first, for a robot that is only being reset, and settling at a few seconds for one that
 * is switched off.
 */
export const DEFAULT_BACKOFF: BackoffOptions = { initialMs: 250, maxMs: 5000, factor: 2 };

/**
 * Capped exponential backoff: each failed attempt waits longer than the last, up to a ceiling,
 * and a success starts over from the shortest wait.
 */
export class Backoff {
  #failures = 0;
  readonly #options: BackoffOptions;

  constructor(options: BackoffOptions = DEFAULT_BACKOFF) {
    this.#options = options;
  }

  /**
   * Count one more failure.
   *
   * @returns How long to wait before the next attempt, in milliseconds.
   */
  next(): number {
    const delay = this.#options.initialMs * this.#options.factor ** this.#failures;
    this.#failures++;
    return Math.min(delay, this.#options.maxMs);
  }

  /** Start over after a success. */
  reset(): void {
    this.#failures = 0;
  }

  /** How many attempts failed in a row. */
  get attempts(): number {
    return this.#failures;
  }
}

/**
 * Wait for a promise, but no longer than a deadline.
 *
 * @param promise What to wait for. It keeps running after the deadline; only the wait ends.
 * @param timeoutMs How long to wait, in milliseconds.
 * @param what What is being waited for, for the error.
 * @returns What the promise resolves to.
 * @throws A `TimeoutError` once the deadline passes first.
 */
export function withTimeout<T>(promise: Promise<T>, timeoutMs: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(what, timeoutMs)), timeoutMs);
  });

  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
