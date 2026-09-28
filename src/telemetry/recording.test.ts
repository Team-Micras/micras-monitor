import { describe, expect, test } from 'vitest';

import { TypeCode } from '@/protocol';

import { MemoryBlockPersistence } from './memory-persistence';
import {
  decodeBlock,
  deserializeRecording,
  encodeBlock,
  encodeRecordingHeader,
  RECORDING_FORMAT,
  RECORDING_FORMAT_VERSION,
  serializeRecording,
  type Recording,
  type RecordingHeader,
} from './recording';

const HEADER: RecordingHeader = {
  format: RECORDING_FORMAT,
  version: RECORDING_FORMAT_VERSION,
  startedAtMs: 1_790_000_000_000,
  robot: { name: 'micras', bootId: 3_735_928_559, schemaHash: '9f1c', simulated: false },
  schema: [
    { id: 0, name: 'odometry/velocity', type: TypeCode.F32, access: 0x01 },
    { id: 1, name: 'localizer/accepted', type: TypeCode.U32, access: 0x01 },
    { id: 2, name: 'maze', type: TypeCode.BLOB },
  ],
};

const RECORDING: Recording = {
  header: HEADER,
  records: [
    {
      kind: 'epoch',
      epoch: {
        epochId: 1,
        groupId: 0,
        variables: [
          { id: 0, type: TypeCode.F32 },
          { id: 1, type: TypeCode.U32 },
        ],
      },
    },
    {
      kind: 'block',
      block: {
        ref: { epochId: 1, index: 0 },
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
        epochId: 1,
        kind: 'dropped',
        index: 4,
        count: 12,
        afterUs: 2 ** 40,
        untilUs: Number.NaN,
      },
    },
    { kind: 'boundary', boundary: { kind: 'reboot', timeUs: 2 ** 40 + 1 } },
    {
      kind: 'epoch',
      epoch: { epochId: 2, groupId: 3, variables: [] },
    },
    {
      kind: 'gap',
      gap: { epochId: 2, kind: 'not-stored', index: 0, count: 1, afterUs: Number.NaN, untilUs: 7 },
    },
  ],
};

function withHeader(json: string): Uint8Array {
  const text = new TextEncoder().encode(json);
  const bytes = new Uint8Array(12 + text.byteLength);
  bytes.set(encodeRecordingHeader(HEADER).subarray(0, 8));
  new DataView(bytes.buffer).setUint32(8, text.byteLength, true);
  bytes.set(text, 12);
  return bytes;
}

describe('recording format v1', () => {
  test('reads back exactly what it wrote', () => {
    const bytes = serializeRecording(RECORDING);

    expect(deserializeRecording(bytes)).toEqual(RECORDING);
  });

  test('reads a recording at any offset of a larger buffer', () => {
    const bytes = serializeRecording(RECORDING);
    const padded = new Uint8Array(bytes.byteLength + 3);
    padded.set(bytes, 3);

    expect(deserializeRecording(padded.subarray(3))).toEqual(RECORDING);
  });

  test('starts with the magic and the JSON header', () => {
    const bytes = encodeRecordingHeader(HEADER);
    const size = new DataView(bytes.buffer).getUint32(8, true);

    expect([...bytes.subarray(0, 8)]).toEqual([0x89, 0x4d, 0x4d, 0x52, 0x45, 0x43, 0x0d, 0x0a]);
    expect(JSON.parse(new TextDecoder().decode(bytes.subarray(12, 12 + size)))).toEqual(HEADER);
  });

  test('skips records of kinds it does not know', () => {
    const bytes = serializeRecording({ header: HEADER, records: [] });
    const unknown = new Uint8Array([0x7f, 0, 0, 0, 3, 0, 0, 0, 1, 2, 3]);
    const joined = new Uint8Array([...bytes, ...unknown]);

    expect(deserializeRecording(joined).records).toEqual([]);
  });

  test('refuses what is not a version 1 recording', () => {
    const future = withHeader(JSON.stringify({ ...HEADER, version: 2 }));
    const malformed = withHeader(JSON.stringify({ ...HEADER, schema: [{ id: 'x' }] }));

    expect(() => deserializeRecording(new Uint8Array(20))).toThrow('Not a monitor recording');
    expect(() => deserializeRecording(future)).toThrow('version 2');
    expect(() => deserializeRecording(malformed)).toThrow('malformed');
  });

  test('keeps the whole records of a recording cut short', () => {
    const bytes = serializeRecording(RECORDING);
    const cut = deserializeRecording(bytes.subarray(0, bytes.byteLength - 5));
    const torn = deserializeRecording(bytes.subarray(0, bytes.byteLength - 36));

    expect(cut.records).toEqual(RECORDING.records.slice(0, -1));
    expect(cut.truncatedAt).toBe(bytes.byteLength - 40);
    expect(torn.records).toEqual(RECORDING.records.slice(0, -1));
    expect(torn.truncatedAt).toBe(bytes.byteLength - 40);
    expect(deserializeRecording(bytes).truncatedAt).toBeUndefined();
  });

  test('refuses values that do not fit the layout', () => {
    expect(() =>
      encodeBlock({
        ref: { epochId: -1, index: 0 },
        startSample: 0,
        time: new Float64Array(0),
        columns: [],
      })
    ).toThrow(RangeError);
  });

  test('encodes blocks for the in-memory persistence layer as copies', async () => {
    const block = RECORDING.records[1];

    if (block.kind !== 'block') {
      throw new Error('The second record is a block');
    }

    const persistence = new MemoryBlockPersistence();
    await persistence.write(block.block);
    const back = await persistence.read(block.block.ref);

    expect(back).toEqual(block.block);
    expect(back.time).not.toBe(block.block.time);
    expect(decodeBlock(encodeBlock(back))).toEqual(back);
    await expect(persistence.read({ epochId: 9, index: 0 })).rejects.toThrow('No block');
  });
});
