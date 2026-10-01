/**
 * READs of one variable, at most one in flight: asked again while one waits, it reads once more
 * after the answer, however many times it was asked.
 *
 * @module
 */

/** Reads one variable on request, coalescing the requests made while a read is in flight. */
export class CoalescedReads {
  readonly #read: () => Promise<unknown>;
  #inFlight = false;
  #again = false;
  #closed = false;

  /** @param read Reads the variable; its answer is not looked at. */
  constructor(read: () => Promise<unknown>) {
    this.#read = read;
  }

  /** Reads now, or once the read in flight is answered. */
  request(): void {
    if (this.#closed) {
      return;
    }

    if (this.#inFlight) {
      this.#again = true;
      return;
    }

    this.#inFlight = true;
    void this.#read().finally(() => {
      this.#inFlight = false;

      if (this.#again) {
        this.#again = false;
        this.request();
      }
    });
  }

  /** Stops reading; requests from now on do nothing. */
  close(): void {
    this.#closed = true;
  }
}
