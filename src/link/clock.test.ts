import { expect, test } from 'vitest';

import { TimestampUnwrapper } from './clock';

const TOP = 2 ** 32;

test('passes timestamps through while they grow', () => {
  const clock = new TimestampUnwrapper();

  expect([10, 20, 1_000_000].map((value, index) => clock.unwrap(value, index))).toEqual([
    10, 20, 1_000_000,
  ]);
  expect(clock.resets).toBe(0);
});

test('unwraps the counter going around', () => {
  const clock = new TimestampUnwrapper();

  clock.unwrap(TOP - 1000, 0);

  expect(clock.unwrap(500, 2)).toBe(TOP + 500);
  expect(clock.unwrap(1500, 3)).toBe(TOP + 1500);
  expect(clock.resets).toBe(0);
});

test('unwraps across a long silence, measured on the host', () => {
  const clock = new TimestampUnwrapper();
  const tenMinutesUs = 600_000_000;

  clock.unwrap(TOP - 1000, 0);

  expect(clock.unwrap(tenMinutesUs, 600_000)).toBe(TOP + tenMinutesUs);
  expect(clock.resets).toBe(0);
});

test('starts over when the robot resets instead of adding a wrap', () => {
  const clock = new TimestampUnwrapper();

  clock.unwrap(90_000_000, 0);

  expect(clock.unwrap(125, 2000)).toBe(125);
  expect(clock.resets).toBe(1);
});

test('a reset shortly after the counter came near the top is still a reset', () => {
  const clock = new TimestampUnwrapper();

  clock.unwrap(TOP - 60_000_000, 0);

  expect(clock.unwrap(125, 1000)).toBe(125);
  expect(clock.resets).toBe(1);
});

test('a reset after a wrap forgets the wrap', () => {
  const clock = new TimestampUnwrapper();

  clock.unwrap(TOP - 1000, 0);
  clock.unwrap(500, 1);

  expect(clock.unwrap(200_000_000, 200_000)).toBe(TOP + 200_000_000);
  expect(clock.unwrap(250, 201_000)).toBe(250);
  expect(clock.resets).toBe(1);
});

test('reset forgets the clock without counting a reset', () => {
  const clock = new TimestampUnwrapper();

  clock.unwrap(TOP - 1000, 0);
  clock.unwrap(500, 1);
  clock.reset();

  expect(clock.unwrap(100, 2)).toBe(100);
  expect(clock.resets).toBe(0);
});
