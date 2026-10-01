import { describe, expect, test } from 'vitest';

import { Emitter } from '@/core/emitter';

import { decodeAccess, MessageType, TypeCode, writeValue } from '@/sources/micras-comm/wire';
import { EpochRegistry, type OpenEpoch } from '@/sources/micras-comm/link/epochs';
import { toGroupLayouts } from '@/sources/micras-comm/link/group-configurator';
import {
  DEFAULT_TIMING,
  LinkTally,
  type LinkContext,
  type LinkEvents,
  type SampleEvent,
} from '@/sources/micras-comm/link/link-events';
import type { GroupAck, Sample } from '@/sources/micras-comm/link/messages';
import { PendingRequests } from '@/sources/micras-comm/link/requests';
import type { SchemaEntry } from '@/sources/micras-comm/link/schema';

const STREAM = decodeAccess(0x01);

const SCHEMA: SchemaEntry[] = [
  { id: 0, name: 'a', type: TypeCode.F32, access: STREAM },
  { id: 1, name: 'b', type: TypeCode.U16, access: STREAM },
  { id: 2, name: 'flag', type: TypeCode.BOOL, access: STREAM },
  { id: 3, name: 'count', type: TypeCode.U64, access: STREAM },
];

const SPACING_US = 10_000;
const LOOP_TIME_US = SPACING_US / 8;
const [LAYOUT] = toGroupLayouts(SCHEMA, [{ variableIds: [0, 2, 3], periodTicks: 8 }]);
const ACK: GroupAck = {
  type: MessageType.GROUP_ACK,
  group: 0,
  periodTicks: 8,
  sampleSize: LAYOUT.sampleSize,
};
const VALUES = new Uint8Array([
  ...writeValue(1.5, TypeCode.F32),
  ...writeValue(true, TypeCode.BOOL),
  ...writeValue(BigInt(2) ** BigInt(60), TypeCode.U64),
]);

/** A registry whose link records what it emits. */
function recordingRegistry() {
  const events: string[] = [];
  const samples: SampleEvent[] = [];
  const counters = new LinkTally();
  const emitter = new Emitter<LinkEvents>();
  const context: LinkContext = {
    timing: DEFAULT_TIMING,
    requests: new PendingRequests(),
    counters,
    generation: () => 0,
    send: () => undefined,
    report: (message) => events.push(message),
    emit: (event, payload) => emitter.emit(event, payload),
  };
  const registry = new EpochRegistry(context);
  registry.beginTimeline('connected');

  emitter.on('sample', (sample) => samples.push(sample));
  emitter.on('epoch', (epoch) => events.push(`epoch ${JSON.stringify(epoch)}`));
  emitter.on('epochEnd', (ended) => events.push(`epochEnd ${JSON.stringify(ended)}`));
  emitter.on('timeline', (timeline) => events.push(`timeline ${JSON.stringify(timeline)}`));

  return { registry, events, samples, counters };
}

function define(registry: EpochRegistry): OpenEpoch {
  return registry.define(LAYOUT, ACK);
}

/** A sample the robot took at its turn, arriving as it was taken. */
function sampleAt(seq: number, index = seq, values = VALUES): [Sample, number] {
  return [
    {
      type: MessageType.SAMPLE,
      group: 0,
      seq,
      timestampUs: (index * SPACING_US) >>> 0,
      values,
    },
    (index * SPACING_US) / 1000,
  ];
}

/** Accept a sample the robot took at its turn: the sample of that index in the epoch. */
function acceptAt(open: OpenEpoch, seq: number, index = seq): number | null {
  const [sample, nowMs] = sampleAt(seq, index);
  return open.accept(sample.seq, sample.timestampUs, SPACING_US, nowMs);
}

describe('epochs', () => {
  test('every definition opens an epoch with a new id', () => {
    const { registry } = recordingRegistry();
    const first = define(registry);
    const second = define(registry);

    expect(second.epoch.id).toBe(first.epoch.id + 1);
    expect(registry.current(0)).toBe(second);
  });

  test('an epoch is announced once enabled, and only an announced one is reported ended', () => {
    const { registry, events } = recordingRegistry();

    define(registry);
    const announced = define(registry).epoch;
    registry.activate(0);
    registry.activate(0);
    const next = define(registry).epoch;
    registry.activate(0);
    registry.end(0, 'disabled');

    expect(events).toEqual([
      `epoch ${JSON.stringify(announced)}`,
      `epochEnd ${JSON.stringify({ epoch: announced, reason: 'redefined' })}`,
      `epoch ${JSON.stringify(next)}`,
      `epochEnd ${JSON.stringify({ epoch: next, reason: 'disabled' })}`,
    ]);
    expect(registry.active()).toEqual([]);
  });

  test('the robot clock starting over carries each stream on under a new epoch, sequence and all', () => {
    const { registry, events, samples } = recordingRegistry();
    const before = define(registry).epoch;
    registry.activate(0);
    const [, second] = toGroupLayouts(SCHEMA, [LAYOUT, { variableIds: [1], periodTicks: 8 }]);
    const waiting = registry.define(second, { ...ACK, group: 1, sampleSize: 2 }).epoch;
    events.length = 0;

    registry.receive({ ...sampleAt(0)[0], timestampUs: 4_000_000_000 }, 1000, LOOP_TIME_US);
    registry.receive({ ...sampleAt(1)[0], timestampUs: 0 }, 1010, LOOP_TIME_US);

    const after = registry.current(0)?.epoch;
    expect(after).toMatchObject({ timeline: before.timeline + 1, variableIds: [0, 2, 3] });
    expect(after?.id).not.toBe(before.id);
    expect(samples.map((sample) => [sample.epoch, sample.missingBefore])).toEqual([
      [before.id, 0],
      [after?.id, 0],
    ]);
    expect(events).toEqual([
      `timeline ${JSON.stringify({ id: before.timeline + 1, reason: 'clock-reset' })}`,
      `epochEnd ${JSON.stringify({ epoch: before, reason: 'clock-reset' })}`,
      `epoch ${JSON.stringify(after)}`,
    ]);
    expect(registry.current(1)?.epoch).toMatchObject({ timeline: waiting.timeline + 1 });
    expect(registry.isActive(1)).toBe(false);
  });

  test('a sequence gap inside an epoch counts the samples dropped', () => {
    const open = define(recordingRegistry().registry);

    expect(acceptAt(open, 0)).toBe(0);
    expect(acceptAt(open, 1)).toBe(0);
    expect(acceptAt(open, 5)).toBe(3);
    expect(acceptAt(open, 6)).toBe(0);
  });

  test('samples dropped before the first one arrived are counted too', () => {
    const open = define(recordingRegistry().registry);

    expect(acceptAt(open, 2)).toBe(2);
  });

  test('the u16 sequence wraps without a gap', () => {
    const open = define(recordingRegistry().registry);

    acceptAt(open, 0);
    acceptAt(open, 0x7ffe);
    acceptAt(open, 0xfffe);

    expect(acceptAt(open, 0xffff)).toBe(0);
    expect(acceptAt(open, 0, 0x10000)).toBe(0);
  });

  test('a sequence behind the expected one is no gap and moves nothing', () => {
    const open = define(recordingRegistry().registry);

    acceptAt(open, 0);
    acceptAt(open, 40);

    expect(acceptAt(open, 0, 41)).toBeNull();
    expect(acceptAt(open, 40, 42)).toBeNull();
    expect(open.nextSeq).toBe(41);
    expect(acceptAt(open, 41, 43)).toBe(0);
  });

  test('the time settles a sequence 1024 or more ahead: a gap that long, or out of step', () => {
    const open = define(recordingRegistry().registry);

    acceptAt(open, 0);

    expect(acceptAt(open, 1023, 1)).toBe(1022);
    expect(acceptAt(open, 3000, 2)).toBeNull();
    expect(acceptAt(open, 3000, 1 + 1976 + 1)).toBe(1976);
    expect(acceptAt(open, 0x8001, 1979)).toBeNull();
    expect(acceptAt(open, 0x8001, 1978 + (0x8001 - 3001) + 1)).toBe(0x8001 - 3001);
  });

  test('counts by the time the samples taken since the last one accepted', () => {
    const open = define(recordingRegistry().registry);

    expect(open.takenSince(5 * SPACING_US, SPACING_US, 50)).toBe(0);

    acceptAt(open, 0);

    expect(open.takenSince(5 * SPACING_US, SPACING_US, 50)).toBe(5);
    expect(open.takenSince(5 * SPACING_US, 0, 50)).toBe(0);
  });

  test('counts no more by the time than the monitor clock allows, whatever the timestamp says', () => {
    const open = define(recordingRegistry().registry);

    acceptAt(open, 0);

    expect(open.takenSince(0x7fff_0000, SPACING_US, 50)).toBe(105);
  });

  test('a new epoch starts its sequence from zero', () => {
    const { registry } = recordingRegistry();
    acceptAt(define(registry), 40);

    expect(acceptAt(define(registry), 0)).toBe(0);
  });

  test('decodes values by type and refuses the wrong size', () => {
    const open = define(recordingRegistry().registry);

    expect(open.decode(VALUES)).toEqual([1.5, 1, BigInt(2) ** BigInt(60)]);
    expect(open.decode(VALUES.subarray(1))).toBeNull();
  });
});

describe('samples', () => {
  test('a sample of a group without an epoch is stray', () => {
    const { registry } = recordingRegistry();

    expect(registry.receive(...sampleAt(0), LOOP_TIME_US)).toBe('stray');
  });

  test('a sample announces its epoch and reports the samples dropped before it', () => {
    const { registry, samples, counters } = recordingRegistry();
    const { epoch } = define(registry);

    expect(registry.receive(...sampleAt(0), LOOP_TIME_US)).toBe('accepted');
    expect(registry.receive(...sampleAt(3), LOOP_TIME_US)).toBe('accepted');

    expect(registry.active()).toEqual([epoch]);
    expect(samples.map((sample) => sample.missingBefore)).toEqual([0, 2]);
    expect(counters.snapshot).toMatchObject({ samples: 2, droppedSamples: 2 });
  });

  test('a sample out of step ends its epoch, counting what the time says was lost', () => {
    const { registry, events, counters } = recordingRegistry();
    const { epoch } = define(registry);
    registry.receive(...sampleAt(0), LOOP_TIME_US);

    const [wrongSize, nowMs] = sampleAt(1, 4, VALUES.subarray(1));

    expect(registry.receive(wrongSize, nowMs, LOOP_TIME_US)).toBe('out-of-step');
    expect(registry.current(0)).toBeUndefined();
    expect(counters.snapshot.droppedSamples).toBe(4);
    expect(events).toContain(
      `A sample of group 0 has ${VALUES.length - 1} bytes; ${VALUES.length} were acknowledged`
    );
    expect(events).toContain(`epochEnd ${JSON.stringify({ epoch, reason: 'out-of-step' })}`);
  });

  test('a group defined again as it was once out of step continues the stream, losses and all', () => {
    const { registry, samples } = recordingRegistry();
    const first = define(registry).epoch;
    registry.receive(...sampleAt(0), LOOP_TIME_US);
    registry.receive(sampleAt(1, 4, VALUES.subarray(1))[0], sampleAt(4)[1], LOOP_TIME_US);

    const again = define(registry).epoch;
    registry.receive(...sampleAt(1, 6), LOOP_TIME_US);

    expect(again.continues).toBe(first.id);
    expect(samples.at(-1)).toMatchObject({ epoch: again.id, missingBefore: 1 + 4 });
  });

  test('a group defined again with other variables, or after it was turned off, starts afresh', () => {
    const { registry } = recordingRegistry();
    define(registry);
    registry.receive(...sampleAt(0), LOOP_TIME_US);
    registry.receive(sampleAt(1, 4, VALUES.subarray(1))[0], sampleAt(4)[1], LOOP_TIME_US);
    const [other] = toGroupLayouts(SCHEMA, [{ variableIds: [0, 1], periodTicks: 8 }]);

    expect(
      registry.define(other, { ...ACK, sampleSize: other.sampleSize }).epoch.continues
    ).toBeUndefined();

    registry.receive(...sampleAt(0), LOOP_TIME_US);
    registry.receive(sampleAt(1, 4, VALUES)[0], sampleAt(4)[1], LOOP_TIME_US);
    registry.end(0, 'failed');

    expect(define(registry).epoch.continues).toBeUndefined();
  });
});
