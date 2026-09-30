import { describe, expect, test } from 'vitest';

import { movedTo, slotAt } from './tab-reorder';

describe('the gap a dragged tab is over', () => {
  const middles = [50, 150, 250];

  test('is before the first tab whose middle is right of the pointer', () => {
    expect(slotAt(middles, 0)).toBe(0);
    expect(slotAt(middles, 49)).toBe(0);
    expect(slotAt(middles, 51)).toBe(1);
    expect(slotAt(middles, 249)).toBe(2);
  });

  test('is after the last tab past its middle', () => {
    expect(slotAt(middles, 251)).toBe(3);
    expect(slotAt([], 10)).toBe(0);
  });
});

describe('where a dropped tab goes', () => {
  test('is the gap, counted without the tab itself', () => {
    expect(movedTo(0, 3)).toBe(2);
    expect(movedTo(0, 2)).toBe(1);
    expect(movedTo(2, 0)).toBe(0);
    expect(movedTo(3, 1)).toBe(1);
  });

  test('is nowhere next to where it was', () => {
    expect(movedTo(1, 1)).toBeNull();
    expect(movedTo(1, 2)).toBeNull();
  });
});
