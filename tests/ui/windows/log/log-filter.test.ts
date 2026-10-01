import { describe, expect, test } from 'vitest';

import type { LogEntry } from '@/core/log';
import { entryTime, filterLog, SHOWN_ENTRIES, sourceLabel } from '@/ui/windows/log/log-filter';

const entry = (severity: LogEntry['severity'], hostTime = 0): LogEntry => ({
  hostTime,
  severity,
  source: 'link',
  text: severity,
});

describe('filterLog', () => {
  test('keeps the entries at least as serious as the minimum', () => {
    const entries = [entry('debug'), entry('info'), entry('warning'), entry('error')];
    expect(filterLog(entries, 'debug')).toBe(entries);
    expect(filterLog(entries, 'warning').map((kept) => kept.severity)).toEqual([
      'warning',
      'error',
    ]);
  });

  test('keeps only the newest entries', () => {
    const entries = Array.from({ length: SHOWN_ENTRIES + 5 }, (_, index) => entry('info', index));
    const shown = filterLog(entries, 'info');
    expect(shown).toHaveLength(SHOWN_ENTRIES);
    expect(shown[0].hostTime).toBe(5);
  });
});

describe('entryTime', () => {
  test('reads the robot clock, the time since the link came up, or the wall clock', () => {
    expect(entryTime({ ...entry('info'), timeUs: 61_500_000, source: 'robot' }, null)).toBe(
      '01:01.5'
    );
    expect(entryTime(entry('info', 12_300), 10_000)).toBe('00:02.3');
    expect(entryTime(entry('info', new Date(2026, 8, 28, 9, 5, 7).getTime()), null)).toBe(
      '09:05:07'
    );
  });
});

describe('sourceLabel', () => {
  test('tags the lines of the link and the history, and none of the robot', () => {
    expect(sourceLabel({ ...entry('info'), source: 'link' })).toBe('link');
    expect(sourceLabel({ ...entry('info'), source: 'history' })).toBe('history');
    expect(sourceLabel({ ...entry('info'), source: 'robot' })).toBeNull();
  });
});
