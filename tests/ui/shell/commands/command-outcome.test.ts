import { describe, expect, test } from 'vitest';

import { commandAnswered, commandSent, noRobotFor } from '@/ui/shell/commands/command-outcome';
import type { CommandSpec } from '@/core/robot';
import { mouse } from '@tests/support/core/robot/packages';

const PKG = mouse({ id: 'micras', displayName: 'Micras' });
const GO: CommandSpec = { code: 0, name: 'GO', label: 'Go', acceptedIn: [0] };
const STOP: CommandSpec = { code: 5, name: 'STOP', label: 'Stop', acceptedIn: 'any' };

describe('command notices', () => {
  test('say when there is no robot and when a command is on its way', () => {
    expect(noRobotFor(1, STOP)).toEqual({
      id: 1,
      tone: 'warning',
      text: 'No robot to send Stop to',
    });
    expect(commandSent(2, GO)).toEqual({ id: 2, tone: 'pending', text: 'Go sent…' });
  });

  test('name the reason of a refusal or a deferral in the package words, for any command', () => {
    expect(commandAnswered(1, STOP, PKG, { status: 'ok', reason: 0 }).text).toBe('Stop accepted');
    expect(commandAnswered(1, GO, PKG, { status: 'refused', reason: 1 })).toEqual({
      id: 1,
      tone: 'error',
      text: 'Go refused: not idle',
    });
    expect(commandAnswered(1, STOP, PKG, { status: 'deferred', reason: 7 }).text).toBe(
      'Stop deferred: reason 7'
    );
    expect(commandAnswered(1, STOP, null, { status: 'deferred', reason: null }).text).toBe(
      'Stop deferred'
    );
    expect(commandAnswered(1, GO, PKG, { status: 'unknown', reason: null }).tone).toBe('error');
    expect(commandAnswered(1, GO, PKG, { status: 'failed', message: 'Not connected.' }).text).toBe(
      'Go failed: Not connected.'
    );
  });
});
