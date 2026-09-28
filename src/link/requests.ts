import type { ErrorCode, WriteStatus } from '../protocol';
import { RobotError, TimeoutError } from './errors';
import type { CommandResult, GroupAck } from './messages';

/** What the robot answers each kind of request with. */
export interface Answers {
  group: GroupAck;
  write: WriteStatus;
  read: Uint8Array;
  command: CommandResult;
  ping: undefined;
}

/** The kinds of request the robot answers. */
export type RequestKind = keyof Answers;

/** Whether an ERROR from the robot is the answer to a request. */
export type ErrorMatcher = (code: ErrorCode, context: number) => boolean;

interface Pending<T> {
  order: number;
  key: number;
  answersError: ErrorMatcher;
  resolve(value: T): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

type PendingByKind = { [K in RequestKind]: Pending<Answers[K]>[] };

const NEVER: ErrorMatcher = () => false;

const KINDS: readonly RequestKind[] = ['group', 'write', 'read', 'command', 'ping'];

/**
 * Requests waiting for the robot's answer.
 *
 * An answer names what it answers (a group, a variable, a command code), so it settles the oldest
 * request of its kind with that key. A lost answer costs its request a timeout and nothing else:
 * the next answer still finds the right request.
 */
export class PendingRequests {
  private readonly pending: PendingByKind = {
    group: [],
    write: [],
    read: [],
    command: [],
    ping: [],
  };
  private sent = 0;

  /**
   * Wait for an answer.
   *
   * @param kind What was asked.
   * @param key What the answer will name.
   * @param timeoutMs How long to wait.
   * @param answersError Which ERRORs are the answer to this request.
   * @returns The answer.
   */
  add<K extends RequestKind>(
    kind: K,
    key: number,
    timeoutMs: number,
    answersError: ErrorMatcher = NEVER
  ): Promise<Answers[K]> {
    const list: Pending<Answers[K]>[] = this.pending[kind];

    return new Promise<Answers[K]>((resolve, reject) => {
      const entry: Pending<Answers[K]> = {
        order: this.sent++,
        key,
        answersError,
        resolve,
        reject,
        timer: setTimeout(() => {
          remove(list, entry);
          reject(new TimeoutError(`${kind} ${key}`, timeoutMs));
        }, timeoutMs),
      };

      list.push(entry);
    });
  }

  /**
   * Settle the oldest request of a kind with a key.
   *
   * @returns Whether a request was waiting for it.
   */
  resolve<K extends RequestKind>(kind: K, key: number, value: Answers[K]): boolean {
    const list: Pending<Answers[K]>[] = this.pending[kind];
    const entry = list.find((each) => each.key === key);

    if (!entry) {
      return false;
    }

    remove(list, entry);
    entry.resolve(value);
    return true;
  }

  /**
   * Fail the oldest request, of any kind, that an ERROR answers.
   *
   * @returns Whether a request was waiting for it.
   */
  refuse(code: ErrorCode, context: number): boolean {
    const oldest = KINDS.map((kind) => this.oldestAnswering(kind, code, context))
      .filter((match) => match !== undefined)
      .toSorted((a, b) => a.entry.order - b.entry.order)[0];

    if (!oldest) {
      return false;
    }

    remove(oldest.list, oldest.entry);
    oldest.entry.reject(new RobotError(code, context));
    return true;
  }

  /**
   * Fail every request of some kinds, or every request.
   *
   * @param error Why.
   * @param kinds The kinds to fail; all of them when left out.
   */
  rejectAll(error: Error, kinds: readonly RequestKind[] = KINDS): void {
    for (const kind of kinds) {
      const list: Pending<unknown>[] = this.pending[kind];

      for (const entry of list.splice(0)) {
        clearTimeout(entry.timer);
        entry.reject(error);
      }
    }
  }

  /** Whether a request of a kind is waiting. */
  has(kind: RequestKind): boolean {
    return this.pending[kind].length > 0;
  }

  private oldestAnswering(kind: RequestKind, code: ErrorCode, context: number) {
    const list: Pending<unknown>[] = this.pending[kind];
    const entry = list.find((each) => each.answersError(code, context));
    return entry ? { list, entry } : undefined;
  }
}

function remove<T>(list: Pending<T>[], entry: Pending<T>): void {
  clearTimeout(entry.timer);

  const index = list.indexOf(entry);

  if (index !== -1) {
    list.splice(index, 1);
  }
}
