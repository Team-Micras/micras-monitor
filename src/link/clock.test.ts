import { expect, test } from 'vitest';

import { TimestampUnwrapper } from './clock';

const TOP = 2 ** 32;

test('passes timestamps through while they grow', () => {
  const clock = new TimestampUnwrapper();

  expect([10, 20, 1_000_000].map((value) => clock.unwrap(value))).toEqual([10, 20, 1_000_000]);
  expect(clock.resets).toBe(0);
});

test('unwraps the counter going around', () => {
  const clock = new TimestampUnwrapper();

  clock.unwrap(TOP - 1000);

  expect(clock.unwrap(500)).toBe(TOP + 500);
  expect(clock.unwrap(1500)).toBe(TOP + 1500);
  expect(clock.resets).toBe(0);
});

test('starts over when the robot resets instead of adding a wrap', () => {
  const clock = new TimestampUnwrapper();

  clock.unwrap(90_000_000);

  expect(clock.unwrap(125)).toBe(125);
  expect(clock.resets).toBe(1);
});

test('a reset after a wrap forgets the wrap', () => {
  const clock = new TimestampUnwrapper();

  clock.unwrap(TOP - 1000);
  clock.unwrap(500);

  expect(clock.unwrap(200_000_000)).toBe(TOP + 200_000_000);
  expect(clock.unwrap(250)).toBe(250);
  expect(clock.resets).toBe(1);
});

test('a step back from near the top to far from zero is a reset, not a wrap', () => {
  const clock = new TimestampUnwrapper();

  clock.unwrap(TOP - 1000);

  expect(clock.unwrap(TOP / 2)).toBe(TOP / 2);
  expect(clock.resets).toBe(1);
});
