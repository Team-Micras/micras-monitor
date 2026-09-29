import { describe, expect, test } from 'vitest';

import { hexRows } from './hex-dump';

describe('hexRows', () => {
  test('splits bytes into lines with offsets, hex and printable ASCII', () => {
    const rows = hexRows(new Uint8Array([0x48, 0x69, 0x00, 0xff, 0x7e]), 4);
    expect(rows).toEqual([
      { offset: '0000', hex: '48 69 00 ff', ascii: 'Hi..' },
      { offset: '0004', hex: '7e', ascii: '~' },
    ]);
    expect(hexRows(new Uint8Array(0))).toEqual([]);
  });
});
