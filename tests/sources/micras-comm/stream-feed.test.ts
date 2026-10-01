import { describe, expect, test } from 'vitest';

import { Emitter } from '@/core/emitter';
import type { SourceSink } from '@/core/source';
import type { Epoch } from '@/sources/micras-comm/link/epochs';
import type { LinkEvents } from '@/sources/micras-comm/link/link-events';
import { StreamFeed } from '@/sources/micras-comm/stream-feed';

const FIRST: Epoch = {
  id: 7,
  group: 0,
  variableIds: [1, 2],
  periodTicks: 8,
  sampleSize: 8,
  timeline: 1,
};

/** A feed over a link the test plays, with what it tells the sink as text. */
function feed() {
  const link = new Emitter<LinkEvents>();
  const told: string[] = [];
  const sink: SourceSink = {
    status: () => undefined,
    variables: () => undefined,
    streamOpened: ({ id, slot }) => told.push(`opened ${id} in ${slot}`),
    streamClosed: (id) => told.push(`closed ${id}`),
    sample: (stream, timeUs, _values, missedBefore) =>
      told.push(`sample ${stream} at ${timeUs} after ${missedBefore}`),
    value: () => undefined,
    boundary: (kind) => told.push(`boundary ${kind}`),
    log: ({ text }) => told.push(text),
    writesChanged: () => undefined,
    stats: () => undefined,
  };
  const streams = new StreamFeed(sink);
  streams.listen({ on: (event, listener) => link.on(event, listener) });

  return { link, told, streams };
}

function sample(epoch: number, timeUs: number, missingBefore = 0) {
  return { epoch, seq: 0, timeUs, values: [0, 5], missingBefore };
}

describe('StreamFeed', () => {
  test('an epoch is a stream, and its samples carry the ones dropped before them', () => {
    const { link, told } = feed();

    link.emit('epoch', FIRST);
    link.emit('sample', sample(7, 100));
    link.emit('sample', sample(7, 300, 1));
    link.emit('epochEnd', { epoch: FIRST, reason: 'disabled' });

    expect(told).toEqual([
      'opened 7 in 0',
      'sample 7 at 100 after 0',
      'sample 7 at 300 after 1',
      'closed 7',
    ]);
  });

  test('a group defined again as it was once out of step carries on the same stream', () => {
    const { link, told } = feed();
    const again: Epoch = { ...FIRST, id: 9, continues: 7 };

    link.emit('epoch', FIRST);
    link.emit('sample', sample(7, 100));
    link.emit('epochEnd', { epoch: FIRST, reason: 'out-of-step' });
    link.emit('state', { kind: 'configuring' });
    link.emit('epoch', again);
    link.emit('sample', sample(9, 900, 6));
    link.emit('state', { kind: 'streaming' });

    expect(told).toEqual(['opened 7 in 0', 'sample 7 at 100 after 0', 'sample 7 at 900 after 6']);
  });

  test('a stream out of step closes once the link settles without it, or another takes its slot', () => {
    const settled = feed();
    settled.link.emit('epoch', FIRST);
    settled.link.emit('epochEnd', { epoch: FIRST, reason: 'out-of-step' });
    settled.link.emit('state', { kind: 'streaming' });

    const replaced = feed();
    replaced.link.emit('epoch', FIRST);
    replaced.link.emit('epochEnd', { epoch: FIRST, reason: 'out-of-step' });
    replaced.link.emit('epoch', { ...FIRST, id: 9, variableIds: [3] });

    expect(settled.told).toEqual(['opened 7 in 0', 'closed 7']);
    expect(replaced.told).toEqual(['opened 7 in 0', 'closed 7', 'opened 9 in 0']);
  });

  test('marks a reconnect when the link starts over, and a reboot on a new run of the clock', () => {
    const { link, told, streams } = feed();

    link.emit('timeline', { id: 1, reason: 'connected' });
    link.emit('state', { kind: 'handshaking', reason: 'stall', attempt: 1 });
    link.emit('timeline', { id: 2, reason: 'reboot' });

    expect(told).toEqual(['boundary reconnect', 'boundary reboot', 'the robot rebooted']);
    expect(streams.clock).toBe(2);
  });

  test('reads the credit left from the variable it watches', () => {
    const { link, streams } = feed();
    streams.watchCredit(2);

    link.emit('epoch', FIRST);
    link.emit('sample', sample(7, 100));

    expect(streams.creditLeft).toBe(5);
  });
});
