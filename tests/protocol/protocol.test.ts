import { expect, test } from 'vitest';

import { decodeAccess } from '@/protocol/protocol';

test('decodes each access flag from its own bit', () => {
  expect(decodeAccess(0x00)).toEqual({ stream: false, write: false, idle: false, persist: false });
  expect(decodeAccess(0x01)).toEqual({ stream: true, write: false, idle: false, persist: false });
  expect(decodeAccess(0x02)).toEqual({ stream: false, write: true, idle: false, persist: false });
  expect(decodeAccess(0x04)).toEqual({ stream: false, write: false, idle: true, persist: false });
  expect(decodeAccess(0x08)).toEqual({ stream: false, write: false, idle: false, persist: true });
});

test('ignores the bits no flag uses', () => {
  expect(decodeAccess(0xf3)).toEqual({ stream: true, write: true, idle: false, persist: false });
});
