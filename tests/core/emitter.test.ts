import { expect, test } from 'vitest';

import { Emitter, type Unsubscribe } from '@/core/emitter';

test('an emit calls the listeners registered when it started', () => {
  const emitter = new Emitter<{ tick: number }>();
  const calls: string[] = [];
  const late = () => calls.push('late');
  let unsubscribeSecond: Unsubscribe | undefined;

  emitter.on('tick', () => {
    calls.push('first');
    unsubscribeSecond?.();
    emitter.on('tick', late);
  });
  unsubscribeSecond = emitter.on('tick', () => calls.push('second'));

  emitter.emit('tick', 1);
  expect(calls).toEqual(['first', 'second']);

  calls.length = 0;
  emitter.emit('tick', 2);
  expect(calls).toEqual(['first', 'late']);
});

test('says whether an event has a listener', () => {
  const emitter = new Emitter<{ tick: number; tock: undefined }>();

  expect(emitter.has('tick')).toBe(false);
  const stop = emitter.on('tick', () => undefined);
  expect(emitter.has('tick')).toBe(true);
  expect(emitter.has('tock')).toBe(false);
  stop();
  expect(emitter.has('tick')).toBe(false);
});
