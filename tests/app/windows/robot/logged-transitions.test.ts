import { describe, expect, test } from 'vitest';

import type { LogEntry } from '@/core/log';
import { loggedTransitions, mergeTransitions } from '@/app/windows/robot/logged-transitions';

const STATES = ['IDLE', 'RUN', 'SAVE'];
const read = (text: string) => {
  const index = STATES.indexOf(/^state (\w+)$/.exec(text)?.[1] ?? '');
  return index < 0 ? null : index;
};

function robot(timeUs: number, text: string): LogEntry {
  return { timeUs, hostTime: 0, severity: 'info', source: 'robot', text };
}

describe('loggedTransitions', () => {
  test('reads the state lines of the robot, in order, and nothing else', () => {
    const entries: LogEntry[] = [
      robot(10, 'state RUN'),
      robot(15, 'localizer: edge'),
      { hostTime: 0, severity: 'info', source: 'link', text: 'state IDLE' },
      robot(20, 'state SAVE'),
      robot(21, 'state SAVE'),
      robot(30, 'state IDLE'),
    ];

    expect(loggedTransitions(entries, read)).toEqual([
      { value: 1, timeUs: 10 },
      { value: 2, timeUs: 20 },
      { value: 0, timeUs: 30 },
    ]);
  });
});

describe('mergeTransitions', () => {
  test('keeps a state shorter than a sample, which only the log has', () => {
    const logged = [
      { value: 1, timeUs: 100 },
      { value: 2, timeUs: 200 },
      { value: 0, timeUs: 201 },
    ];
    const sampled = [
      { value: 1, timeUs: 150 },
      { value: 0, timeUs: 250 },
    ];

    expect(mergeTransitions(logged, sampled)).toBe(logged);
  });

  test('adds what was sampled before the first line and where a line was lost', () => {
    const logged = [{ value: 1, timeUs: 100 }];
    const sampled = [
      { value: 0, timeUs: 50 },
      { value: 1, timeUs: 150 },
      { value: 0, timeUs: 300 },
    ];

    expect(mergeTransitions(logged, sampled)).toEqual([
      { value: 0, timeUs: 50 },
      { value: 1, timeUs: 100 },
      { value: 0, timeUs: 300 },
    ]);
  });

  test('is the sampled history when nothing was logged', () => {
    const sampled = [
      { value: 0, timeUs: 50 },
      { value: 1, timeUs: 150 },
    ];

    expect(mergeTransitions([], sampled)).toEqual(sampled);
  });
});
