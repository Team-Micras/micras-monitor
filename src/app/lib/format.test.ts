import { describe, expect, test } from 'vitest';

import { formatClock, formatHash, formatValue } from './format';

describe('formatValue', () => {
  test('shows integers whole and other numbers with three decimals', () => {
    expect(formatValue(42)).toBe('42');
    expect(formatValue(0.5953)).toBe('0.595');
    expect(formatValue(-0.0123)).toBe('-0.012');
  });

  test('shows a blob by its size and a missing value as a dash', () => {
    expect(formatValue(new Uint8Array(131))).toBe('131 B');
    expect(formatValue(undefined)).toBe('—');
  });
});

describe('formatClock', () => {
  test('counts minutes, seconds and tenths', () => {
    expect(formatClock(0)).toBe('00:00.0');
    expect(formatClock(43_070)).toBe('00:43.0');
    expect(formatClock(125_990)).toBe('02:05.9');
  });

  test('clamps negative durations to zero', () => {
    expect(formatClock(-5)).toBe('00:00.0');
  });
});

test('formatHash pads to eight digits', () => {
  expect(formatHash(0x3f9a1c07)).toBe('3f9a1c07');
  expect(formatHash(0xab)).toBe('000000ab');
});
