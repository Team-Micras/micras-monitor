import { describe, expect, test } from 'vitest';

import { BoundedLog, type LogEntry } from '@/core/log';

function line(
  text: string,
  source: LogEntry['source'] = 'link',
  severity: LogEntry['severity'] = 'warning',
  hostTime = 0
): LogEntry {
  return { hostTime, severity, source, text };
}

describe('BoundedLog', () => {
  test('keeps the newest entries, oldest first', () => {
    const log = new BoundedLog(2);

    log.add(line('a', 'robot', 'info'));
    log.add(line('b', 'robot', 'info'));
    log.add(line('c', 'robot', 'info'));

    expect(log.entries.map((entry) => entry.text)).toEqual(['b', 'c']);
  });

  test('folds a link warning noted again into one entry that counts it and moves to the end', () => {
    const log = new BoundedLog();

    log.add(line('bad sample', 'link', 'warning', 1));
    log.add(line('state RUN', 'robot', 'info', 2));
    log.add(line('bad sample', 'link', 'warning', 3));
    log.add(line('bad sample', 'link', 'warning', 4));

    expect(log.entries).toEqual([
      line('state RUN', 'robot', 'info', 2),
      { ...line('bad sample', 'link', 'warning', 4), count: 3 },
    ]);
  });

  test('keeps every robot line and every link line that is not a warning', () => {
    const log = new BoundedLog();

    log.add(line('state RUN', 'robot', 'warning'));
    log.add(line('state RUN', 'robot', 'warning'));
    log.add(line('disconnected', 'link', 'info'));
    log.add(line('disconnected', 'link', 'info'));

    expect(log.entries).toHaveLength(4);
    expect(log.entries.every((entry) => entry.count === undefined)).toBe(true);
  });

  test('a flood of the same warnings never pushes the robot lines out', () => {
    const log = new BoundedLog(10);

    log.add(line('state RUN', 'robot', 'info'));

    for (let index = 0; index < 1000; index++) {
      log.add(line(`group ${index % 2} is out of step`));
    }

    expect(log.entries.map((entry) => [entry.text, entry.count])).toEqual([
      ['state RUN', undefined],
      ['group 0 is out of step', 500],
      ['group 1 is out of step', 500],
    ]);
  });
});
