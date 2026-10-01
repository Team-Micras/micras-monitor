import { describe, expect, test } from 'vitest';

import { sameTransportStatus } from '@/sources/micras-comm/connection-status';

describe('sameTransportStatus', () => {
  test('takes retries that only count on as the same status', () => {
    expect(
      sameTransportStatus({ kind: 'connecting', attempt: 1 }, { kind: 'connecting', attempt: 2 })
    ).toBe(true);
    expect(
      sameTransportStatus(
        { kind: 'closed', reason: 'lost', retryInMs: 250, error: new Error('gone') },
        { kind: 'closed', reason: 'lost', retryInMs: 500, error: new Error('gone') }
      )
    ).toBe(true);
  });

  test('tells apart what the status shows: the kind, a retry given up, the reason and the error', () => {
    const lost = { kind: 'closed', reason: 'lost', retryInMs: 250 } as const;

    expect(sameTransportStatus({ kind: 'open' }, { kind: 'connecting', attempt: 1 })).toBe(false);
    expect(sameTransportStatus(lost, { kind: 'closed', reason: 'lost' })).toBe(false);
    expect(sameTransportStatus(lost, { ...lost, reason: 'failed' })).toBe(false);
    expect(sameTransportStatus(lost, { ...lost, error: new Error('gone') })).toBe(false);
    expect(sameTransportStatus(null, { kind: 'open' })).toBe(false);
    expect(sameTransportStatus(null, null)).toBe(true);
  });
});
