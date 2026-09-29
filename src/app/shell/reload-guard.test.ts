import { describe, expect, test } from 'vitest';

import { reloadBlock, type ReloadFacts } from './reload-guard';

const linkedIdle: ReloadFacts = { link: 'linked', idle: true, hasPackage: true, lastIdle: true };

describe('reloadBlock', () => {
  test('lets a linked robot at rest reload', () => {
    expect(reloadBlock(linkedIdle)).toBeNull();
  });

  test('holds back a linked robot that runs, or whose state is unknown', () => {
    expect(reloadBlock({ ...linkedIdle, idle: false, lastIdle: false })).toBe('not-idle');
    expect(reloadBlock({ ...linkedIdle, idle: null, lastIdle: null })).toBe('not-idle');
  });

  test('asks a linked robot with no package to disconnect first', () => {
    expect(reloadBlock({ ...linkedIdle, hasPackage: false, idle: null })).toBe('disconnect');
  });

  test.each(['connecting', 'handshaking'] as const)(
    'holds back the reload while the link is %s, whatever the state was',
    (link) => {
      expect(reloadBlock({ ...linkedIdle, link, idle: null, lastIdle: false })).toBe('not-idle');
      expect(reloadBlock({ ...linkedIdle, link, idle: null, lastIdle: true })).toBe('disconnect');
      expect(reloadBlock({ ...linkedIdle, link, idle: null, lastIdle: null })).toBe('disconnect');
    }
  );

  test('asks to disconnect after a drop from a state that was not idle', () => {
    expect(reloadBlock({ ...linkedIdle, link: 'failed', idle: null, lastIdle: false })).toBe(
      'disconnect'
    );
    expect(reloadBlock({ ...linkedIdle, link: 'failed', idle: null, lastIdle: true })).toBeNull();
    expect(reloadBlock({ ...linkedIdle, link: 'failed', idle: null, lastIdle: null })).toBeNull();
  });

  test('holds back the reload while recording, whatever the robot does', () => {
    expect(reloadBlock({ ...linkedIdle, recording: true })).toBe('recording');
    expect(
      reloadBlock({
        link: 'disconnected',
        idle: null,
        hasPackage: false,
        lastIdle: null,
        recording: true,
      })
    ).toBe('recording');
    expect(reloadBlock({ ...linkedIdle, recording: false })).toBeNull();
  });

  test('lets the user reload after disconnecting on purpose', () => {
    expect(
      reloadBlock({ ...linkedIdle, link: 'disconnected', idle: null, lastIdle: null })
    ).toBeNull();
  });
});
