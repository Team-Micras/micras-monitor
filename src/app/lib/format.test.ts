import { describe, expect, test } from 'vitest';

import { formatBytes, formatClock, formatDuration, formatHash, formatValue } from './format';

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

  test('keeps every digit of a 64 bit integer and names booleans', () => {
    expect(formatValue(18_446_744_073_709_551_615n)).toBe('18446744073709551615');
    expect(formatValue(true)).toBe('true');
    expect(formatValue('idle')).toBe('idle');
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

test('formatBytes picks the unit and keeps a decimal below a hundred', () => {
  expect(formatBytes(0)).toBe('0 B');
  expect(formatBytes(1023)).toBe('1023 B');
  expect(formatBytes(1536)).toBe('1.5 KB');
  expect(formatBytes(38 * 1024 * 1024)).toBe('38.0 MB');
  expect(formatBytes(250 * 1024 * 1024)).toBe('250 MB');
});

test('formatDuration shows hours only past an hour', () => {
  expect(formatDuration(0)).toBe('00:00');
  expect(formatDuration(722_300)).toBe('12:02');
  expect(formatDuration(3_723_000)).toBe('1:02:03');
});
