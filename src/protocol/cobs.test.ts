import { describe, expect, test } from 'vitest';

import { decode, DELIMITER, encode, encodedSize } from './cobs';

function rampPayload(size: number): Uint8Array {
  return new Uint8Array(size).map((_, index) => (index * 37) % 256);
}

function nonZeroPayload(size: number): Uint8Array {
  return new Uint8Array(size).map((_, index) => (index % 255) + 1);
}

function expectRoundTrip(payload: Uint8Array): void {
  const encoded = encode(payload);

  expect(encoded.includes(DELIMITER)).toBe(false);
  expect(encoded.length).toBeLessThanOrEqual(encodedSize(payload.length));
  expect(decode(encoded)).toEqual(payload);
}

const ZERO_HEAVY_PAYLOADS: Record<string, Uint8Array> = {
  'a single zero': new Uint8Array([0]),
  'only zeros': new Uint8Array(200),
  'a zero at each end': new Uint8Array([0, 1, 2, 3, 0]),
  'alternating zeros': new Uint8Array(64).map((_, index) => (index % 2 === 0 ? 0 : index)),
  'runs of zeros': new Uint8Array([7, 0, 0, 0, 9, 0, 0, 11]),
  'a zero after 254 non-zero bytes': new Uint8Array([...nonZeroPayload(254), 0]),
};

describe('COBS', () => {
  test('encodes an empty buffer to a single code byte', () => {
    expect([...encode(new Uint8Array(0))]).toEqual([1]);
    expect(decode(new Uint8Array([1]))).toEqual(new Uint8Array(0));
  });

  test.each(Array.from({ length: 200 }, (_, size) => size))(
    'round trips a ramp of %i bytes without a delimiter',
    (size) => {
      expectRoundTrip(rampPayload(size));
    }
  );

  test.each(Object.entries(ZERO_HEAVY_PAYLOADS))('round trips %s', (_, payload) => {
    expectRoundTrip(payload);
  });

  test.each([253, 254, 255, 508, 509, 600])(
    'round trips %i non-zero bytes across the 254 byte block boundary',
    (size) => {
      expectRoundTrip(nonZeroPayload(size));
    }
  );

  test('refuses a frame containing a delimiter', () => {
    expect(decode(new Uint8Array([2, 1, 0, 1]))).toBeNull();
  });

  test('refuses a code that runs past the end of the frame', () => {
    expect(decode(new Uint8Array([5, 1, 2]))).toBeNull();
  });
});
