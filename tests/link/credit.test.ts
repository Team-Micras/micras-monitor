import { expect, test } from 'vitest';

import { encodeFrame, MessageType } from '@/protocol';
import { CumulativeCredit, isMetered, wireSize } from '@/link/credit';

test('only what the robot sends on its own is metered', () => {
  expect(isMetered(MessageType.SAMPLE)).toBe(true);
  expect(isMetered(MessageType.SCHEMA_PAGE)).toBe(true);
  expect(isMetered(MessageType.LOG)).toBe(true);
  expect(isMetered(MessageType.HELLO_ACK)).toBe(false);
  expect(isMetered(MessageType.PONG)).toBe(false);
});

test.each([0, 1, 7, 60, 199, 200])('wire size matches the encoded frame for %i bytes', (size) => {
  const payload = new Uint8Array(size).map((_, index) => index % 3);

  expect(wireSize(size)).toBe(encodeFrame(MessageType.SAMPLE, payload).length);
});

function total(grant: { payload: Uint8Array } | null): number | undefined {
  return grant ? new DataView(grant.payload.buffer).getUint32(0, true) : undefined;
}

test('holds credit back until 64 bytes are owed, then says the total consumed', () => {
  const credit = new CumulativeCredit();

  credit.received(30, 0);
  expect(credit.take(1)).toBeNull();

  credit.received(34, 2);
  expect(credit.take(2)).toEqual({ payload: new Uint8Array([64, 0, 0, 0]), bytes: 64 });
  expect(credit.take(3)).toBeNull();
  expect(credit.dueAt()).toBeNull();

  credit.received(70, 4);
  expect(credit.take(4)).toMatchObject({ bytes: 70 });
});

test('gives a small debt back 10 ms after its first byte', () => {
  const credit = new CumulativeCredit();

  credit.received(12, 100);
  expect(credit.dueAt()).toBe(110);
  expect(credit.take(109)).toBeNull();
  expect(credit.take(110)).toMatchObject({ bytes: 12 });
});

test('the total wraps at 2 to the 32', () => {
  const credit = new CumulativeCredit({ minBytes: 1, maxDelayMs: 0 });

  expect(credit.resync(2 ** 32 - 100, 0)).toBeNull();

  credit.reset();
  for (let step = 0; step < 2 ** 32 / 2 ** 16 - 1; step++) {
    credit.received(2 ** 16, 0);
  }
  credit.take(0);
  credit.received(2 ** 16 - 16, 0);
  expect(credit.take(0)).toMatchObject({ bytes: 2 ** 16 - 16 });

  credit.received(40, 0);
  const grant = credit.take(0);
  expect(grant?.bytes).toBe(40);
  expect(total(grant)).toBe(24);
});

test('a PONG gives back what was lost on the way, at once', () => {
  const credit = new CumulativeCredit();

  credit.received(100, 0);
  credit.take(0);
  credit.received(20, 1);

  expect(credit.resync(180, 2)).toBe(60);
  expect(credit.dueAt()).toBeLessThanOrEqual(2);

  const grant = credit.take(2);
  expect(grant?.bytes).toBe(80);
  expect(total(grant)).toBe(180);
});

test('a PONG with nothing lost says the total again, in case its CREDIT was lost', () => {
  const credit = new CumulativeCredit();

  credit.received(100, 0);
  credit.take(0);

  expect(credit.resync(100, 1)).toBe(0);
  expect(total(credit.take(1))).toBe(100);
  expect(credit.take(2)).toBeNull();
});

test('a PONG before anything was sent says nothing', () => {
  const credit = new CumulativeCredit();

  expect(credit.resync(0, 1)).toBe(0);
  expect(credit.take(1)).toBeNull();
});

test('a PONG counting less than already arrived is a robot that started over', () => {
  const credit = new CumulativeCredit();

  credit.received(100, 0);

  expect(credit.resync(40, 1)).toBeNull();
  expect(credit.resync(100 + 257, 1)).toBeNull();
});

test('starts over from zero when the window resets', () => {
  const credit = new CumulativeCredit();

  credit.received(100, 0);
  credit.reset();

  expect(credit.take(50)).toBeNull();
  credit.received(64, 60);
  expect(total(credit.take(60))).toBe(64);
});
