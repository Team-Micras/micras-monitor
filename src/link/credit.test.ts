import { expect, test } from 'vitest';

import { encodeFrame, MessageType } from '../protocol';
import { CoalescingCredit, isMetered, wireSize } from './credit';

test('only what the robot sends on its own is metered', () => {
  expect(isMetered(MessageType.SAMPLE)).toBe(true);
  expect(isMetered(MessageType.SCHEMA_PAGE)).toBe(true);
  expect(isMetered(MessageType.HELLO_ACK)).toBe(false);
  expect(isMetered(MessageType.LOG)).toBe(false);
  expect(isMetered(MessageType.PONG)).toBe(false);
});

test.each([0, 1, 7, 60, 199, 200])('wire size matches the encoded frame for %i bytes', (size) => {
  const payload = new Uint8Array(size).map((_, index) => index % 3);

  expect(wireSize(size)).toBe(encodeFrame(MessageType.SAMPLE, payload).length);
});

test('holds credit back until 64 bytes are owed', () => {
  const credit = new CoalescingCredit();

  credit.received(30, 0);
  expect(credit.take(1)).toBeNull();

  credit.received(34, 2);
  expect(credit.take(2)).toBe(64);
  expect(credit.take(3)).toBeNull();
  expect(credit.dueAt()).toBeNull();
});

test('gives a small debt back 10 ms after its first byte', () => {
  const credit = new CoalescingCredit();

  credit.received(12, 100);
  expect(credit.dueAt()).toBe(110);
  expect(credit.take(109)).toBeNull();
  expect(credit.take(110)).toBe(12);
});

test('forgets what was owed when the window resets', () => {
  const credit = new CoalescingCredit();

  credit.received(100, 0);
  credit.reset();

  expect(credit.take(50)).toBeNull();
});
