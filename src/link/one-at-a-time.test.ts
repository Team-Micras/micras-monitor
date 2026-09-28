import { expect, test } from 'vitest';

import { OneAtATime } from './one-at-a-time';

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

test('starts a task at once when none runs, and the next one only once it settled', async () => {
  const turns = new OneAtATime();
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
  const turns = new OneAtATime();
  const first = deferred();

  const failing = turns.run(() => first.promise);
  const next = turns.run(() => Promise.resolve('ran'));

  first.reject(new Error('refused'));

  await expect(failing).rejects.toThrow('refused');
  expect(await next).toBe('ran');
});
