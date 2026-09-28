import { describe, expect, test } from 'vitest';

import { emergencyCommand } from '@/robot-kit';
import { mouse } from '@/robot-kit/fixtures/packages';

import { nothingToStop, stopAnswered, stopSent } from './stop-outcome';

const PKG = mouse({ id: 'micras', displayName: 'Micras' });
const STOP = emergencyCommand(PKG);

describe('stop notices', () => {
  test('say when there is nothing to stop and when STOP is on its way', () => {
    expect(nothingToStop(1)).toEqual({ id: 1, tone: 'warning', text: 'Nothing to stop' });
    expect(STOP === null ? null : stopSent(2, STOP)).toEqual({
      id: 2,
      tone: 'pending',
      text: 'Stop sent…',
    });
  });

  test('name the reason of a refusal or a deferral in the package words', () => {
    if (STOP === null) {
      throw new Error('the fixture package has no emergency command');
    }

    expect(stopAnswered(1, STOP, PKG, { status: 'ok', reason: 0 }).text).toBe('Stop accepted');
    expect(stopAnswered(1, STOP, PKG, { status: 'refused', reason: 1 })).toEqual({
      id: 1,
      tone: 'error',
      text: 'Stop refused: not idle',
    });
    expect(stopAnswered(1, STOP, PKG, { status: 'deferred', reason: 7 }).text).toBe(
      'Stop deferred: reason 7'
    );
    expect(stopAnswered(1, STOP, null, { status: 'deferred', reason: null }).text).toBe(
      'Stop deferred'
    );
    expect(stopAnswered(1, STOP, PKG, { status: 'unknown', reason: null }).tone).toBe('error');
    expect(stopAnswered(1, STOP, PKG, { status: 'failed', message: 'Not connected.' }).text).toBe(
      'Stop failed: Not connected.'
    );
  });
});
