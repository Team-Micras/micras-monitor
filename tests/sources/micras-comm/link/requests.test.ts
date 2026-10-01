import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { ErrorCode } from '@/sources/micras-comm/wire';
import { RobotError, TimeoutError } from '@/sources/micras-comm/link/errors';
import { CommandResult, MessageType, Severity } from '@/sources/micras-comm/wire';
import { AsyncMutex, PendingRequests } from '@/sources/micras-comm/link/requests';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

test('an answer settles the oldest request of its kind and key', async () => {
  const requests = new PendingRequests();
  const first = requests.add('read', 3, 100);
  const second = requests.add('read', 3, 100);

  requests.resolve('read', 3, new Uint8Array([1]));
  requests.resolve('read', 3, new Uint8Array([2]));

  await expect(first).resolves.toEqual(new Uint8Array([1]));
  await expect(second).resolves.toEqual(new Uint8Array([2]));
});

test('a lost answer costs only its own request', async () => {
  const requests = new PendingRequests();
  const lost = requests.add('command', 1, 100).catch((error: unknown) => error);

  vi.advanceTimersByTime(100);
  expect(await lost).toBeInstanceOf(TimeoutError);

  const next = requests.add('command', 1, 100);
  requests.resolve('command', 1, { result: CommandResult.OK });
  await expect(next).resolves.toEqual({ result: CommandResult.OK });
});

test('an ERROR fails the oldest request it answers, of any kind', async () => {
  const requests = new PendingRequests();
  const write = requests.add(
    'write',
    7,
    100,
    (code, context) => code === ErrorCode.MALFORMED && context === 7
  );
  const read = requests.add('read', 7, 100, (code) => code === ErrorCode.NO_SUCH_VARIABLE);

  expect(requests.refuse(ErrorCode.NO_SUCH_VARIABLE, 7)).toBe(true);
  expect(requests.refuse(ErrorCode.UNKNOWN_TYPE, 0)).toBe(false);

  await expect(read).rejects.toBeInstanceOf(RobotError);
  requests.resolve('write', 7, 0);
  await expect(write).resolves.toBe(0);
});

test('a message settles the request it answers, and anything else answers nothing', async () => {
  const requests = new PendingRequests();
  const command = requests.add('command', 4, 100);
  const ping = requests.add('ping', 0, 100);

  expect(
    requests.answer({
      type: MessageType.COMMAND_ACK,
      code: 4,
      result: CommandResult.REFUSED,
      reason: 2,
    })
  ).toBe(true);
  expect(requests.answer({ type: MessageType.PONG, sentTotal: 9 })).toBe(true);
  expect(requests.answer({ type: MessageType.PONG, sentTotal: 9 })).toBe(false);
  expect(
    requests.answer({ type: MessageType.LOG, severity: Severity.INFO, timestampUs: 0, text: '' })
  ).toBe(false);

  await expect(command).resolves.toEqual({ result: CommandResult.REFUSED, reason: 2 });
  await expect(ping).resolves.toMatchObject({ sentTotal: 9 });
});

interface Deferred {
  promise: Promise<void>;
  resolve(): void;
  reject(error: Error): void;
}

function deferred(): Deferred {
  const settlers: Partial<Pick<Deferred, 'resolve' | 'reject'>> = {};
  const promise = new Promise<void>((resolve, reject) => {
    settlers.resolve = resolve;
    settlers.reject = reject;
  });

  return {
    promise,
    resolve: () => settlers.resolve?.(),
    reject: (error) => settlers.reject?.(error),
  };
}

describe('AsyncMutex', () => {
  test('starts a task at once when none runs, and the next one only once it settled', async () => {
    const turns = new AsyncMutex();
    const first = deferred();
    const started: string[] = [];

    const running = turns.run(() => {
      started.push('first');
      return first.promise;
    });
    const waiting = turns.run(() => {
      started.push('second');
      return Promise.resolve();
    });

    expect(started).toEqual(['first']);

    first.resolve();
    await running;
    await waiting;

    expect(started).toEqual(['first', 'second']);
  });

  test('a task that fails lets the next one run', async () => {
    const turns = new AsyncMutex();
    const first = deferred();

    const failing = turns.run(() => first.promise);
    const next = turns.run(() => Promise.resolve('ran'));

    first.reject(new Error('refused'));

    await expect(failing).rejects.toThrow('refused');
    expect(await next).toBe('ran');
  });
});
