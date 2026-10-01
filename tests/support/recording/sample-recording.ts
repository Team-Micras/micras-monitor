/**
 * A small recording with a record of every kind, for the tests of the recording format.
 *
 * @module
 */

import {
  RECORDING_FORMAT,
  RECORDING_FORMAT_VERSION,
  type RecordingHeader,
  type RecordingRecord,
} from '@/recording';

import type { Recording } from './recording-bytes';

/** The access of a streamed variable. */
export const STREAM = { stream: true, write: false, writeNeedsIdle: false, persists: false };

/** The header of the sample recording. */
export const HEADER: RecordingHeader = {
  format: RECORDING_FORMAT,
  version: RECORDING_FORMAT_VERSION,
  startedAtMs: 1_790_000_000_000,
  robot: { name: 'micras', bootId: 3_735_928_559, schemaHash: '9f1c', simulated: false },
  schema: [
    { id: 0, name: 'odometry/velocity', type: 'f32', access: STREAM },
    { id: 1, name: 'localizer/accepted', type: 'u32', access: STREAM },
    {
      id: 2,
      name: 'maze',
      type: 'bytes',
      access: { stream: false, write: false, writeNeedsIdle: false, persists: true },
      tag: 'maze-grid',
    },
  ],
};

/** One record of each kind and every kind of value, as a recorder writes them. */
export const RECORDS: readonly RecordingRecord[] = [
  {
    kind: 'run',
    run: {
      runId: 1,
      slot: 0,
      variables: [
        { id: 0, name: 'odometry/velocity', type: 'f32' },
        { id: 1, name: 'localizer/accepted', type: 'u32' },
      ],
    },
  },
  {
    kind: 'block',
    block: {
      ref: { runId: 1, index: 0 },
      startSample: 0,
      time: new Float64Array([0, 125, 250.5, 2 ** 40]),
      columns: [
        {
          variableId: 0,
          values: new Float32Array([1.5, Number.NaN, -0, Number.NEGATIVE_INFINITY]),
        },
        { variableId: 1, values: new Float64Array([4_294_967_295, 16_777_217, 0, 1]) },
      ],
    },
  },
  {
    kind: 'gap',
    gap: {
      runId: 1,
      kind: 'dropped',
      index: 4,
      count: 12,
      startUs: 2 ** 40,
      afterUs: 2 ** 40,
      untilUs: Number.NaN,
    },
  },
  { kind: 'boundary', boundary: { kind: 'reboot', timeUs: 2 ** 40 + 1 } },
  { kind: 'boundary', boundary: { kind: 'schema', timeUs: 2 ** 40 + 2 } },
  { kind: 'run-closed', runId: 1 },
  { kind: 'run', run: { runId: 2, slot: 3, variables: [] } },
  {
    kind: 'gap',
    gap: {
      runId: 2,
      kind: 'not-stored',
      index: 0,
      count: 1,
      startUs: 3,
      afterUs: Number.NaN,
      untilUs: 7,
    },
  },
  {
    kind: 'value',
    value: { variableId: 2, name: 'maze', timeUs: 9, value: new Uint8Array([0xde, 0xad]) },
  },
  { kind: 'value', value: { variableId: 7, name: 'n', timeUs: Number.NaN, value: -(2n ** 63n) } },
  { kind: 'value', value: { variableId: 8, name: 'ok', timeUs: 1, value: true } },
  { kind: 'value', value: { variableId: 10, name: 'x', timeUs: 1, value: -0.5 } },
];

/** The sample recording. */
export const RECORDING: Recording = { header: HEADER, records: RECORDS };

/** Bytes laid end to end. */
export function join(...parts: Uint8Array[]): Uint8Array {
  const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let offset = 0;

  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }

  return bytes;
}
