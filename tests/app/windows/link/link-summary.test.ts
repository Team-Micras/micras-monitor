import { describe, expect, test } from 'vitest';

import { formatHz, formatRate, orderedStreams, share } from '@/app/windows/link/link-summary';

describe('link summary', () => {
  test('formats rates and hertz', () => {
    expect(formatRate(850.4)).toBe('850 B/s');
    expect(formatRate(3170)).toBe('3.2 KB/s');
    expect(formatRate(Number.NaN)).toBe('—');
    expect(formatHz(100)).toBe('100');
    expect(formatHz(2.5)).toBe('2.5');
    expect(formatHz(0)).toBe('0');
  });

  test('clamps shares and survives a zero total', () => {
    expect(share(50, 200)).toBe(0.25);
    expect(share(300, 200)).toBe(1);
    expect(share(1, 0)).toBe(0);
  });

  test('lists the streams the planner cut first', () => {
    const streams = orderedStreams({
      bytesPerSecond: 3000,
      used: 3000,
      overBudget: true,
      planned: [
        { variable: 'b', rateHz: 10, grantedHz: 10 },
        { variable: 'c', rateHz: 100, grantedHz: 25 },
        { variable: 'a', rateHz: 10, grantedHz: 10 },
      ],
    });
    expect(streams.map((stream) => stream.variable)).toEqual(['c', 'a', 'b']);
  });
});
