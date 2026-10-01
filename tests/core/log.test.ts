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

  test('a warning repeated between robot lines takes one entry, so it never pushes them out', () => {
    const log = new BoundedLog(10);

    for (let index = 0; index < 1000; index++) {
      log.add(line('group 0 is out of step'));
      log.add(line(`tick ${index}`, 'robot', 'debug'));
    }

    expect(log.entries.filter((entry) => entry.source === 'link')).toEqual([
      { ...line('group 0 is out of step'), count: 1000 },
    ]);
    expect(log.entries.map((entry) => entry.text).slice(-2)).toEqual([
      'group 0 is out of step',
      'tick 999',
    ]);
  });

  test('a warning that comes back after another link line starts a new entry, keeping the order', () => {
    const log = new BoundedLog();

    log.add(line('bad sample', 'link', 'warning', 1));
    log.add(line('disconnected', 'link', 'info', 2));
    log.add(line('bad sample', 'link', 'warning', 3));
    log.add(line('other fault', 'link', 'warning', 4));
    log.add(line('bad sample', 'link', 'warning', 5));

    expect(log.entries.map((entry) => [entry.text, entry.hostTime, entry.count])).toEqual([
      ['bad sample', 1, undefined],
      ['disconnected', 2, undefined],
      ['bad sample', 3, undefined],
      ['other fault', 4, undefined],
      ['bad sample', 5, undefined],
    ]);
  });
});
