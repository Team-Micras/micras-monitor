import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { ErrorCode } from '@/sources/micras-comm/wire';
import { RobotError, TimeoutError } from '@/sources/micras-comm/link/errors';
import { CommandResult } from '@/sources/micras-comm/wire';
import { PendingRequests } from '@/sources/micras-comm/link/requests';

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
