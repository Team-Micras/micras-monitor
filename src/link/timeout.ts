import { TimeoutError } from './errors';

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
