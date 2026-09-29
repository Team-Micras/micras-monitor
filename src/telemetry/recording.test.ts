import { describe, expect, test } from 'vitest';

import { TypeCode } from '@/protocol';

import { crc32 } from './crc32';
import { MemoryBlockPersistence } from './memory-persistence';
import {
  decodeBlock,
  deserializeRecording,
  encodeBlock,
  encodeRecordingHeader,
  encodeRecordingRecord,
  peekBlock,
  RECORDING_FORMAT,
  RECORDING_FORMAT_VERSION,
  recordOf,
  scanRecording,
  serializeRecording,
  type Recording,
  type RecordingHeader,
  type RecordingRecord,
} from './recording';

const RECORD_KIND_BOUNDARY = 4;

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

const RECORDS: readonly RecordingRecord[] = [
  {
    kind: 'epoch',
    epoch: {
      epochId: 1,
      groupId: 0,
      variables: [
        { id: 0, name: 'odometry/velocity', type: TypeCode.F32 },
        { id: 1, name: 'localizer/accepted', type: TypeCode.U32 },
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
      startUs: 2 ** 40,
      afterUs: 2 ** 40,
      untilUs: Number.NaN,
    },
  },
  { kind: 'boundary', boundary: { kind: 'reboot', timeUs: 2 ** 40 + 1 } },
  { kind: 'boundary', boundary: { kind: 'schema', timeUs: 2 ** 40 + 2 } },
  { kind: 'epoch-closed', epochId: 1 },
  { kind: 'epoch', epoch: { epochId: 2, groupId: 3, variables: [] } },
  {
    kind: 'gap',
    gap: {
      epochId: 2,
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
  { kind: 'value', value: { variableId: 9, name: 'label', timeUs: 1, value: 'árvore' } },
  { kind: 'value', value: { variableId: 10, name: 'x', timeUs: 1, value: -0.5 } },
];

const RECORDING: Recording = { header: HEADER, records: RECORDS };

function withHeader(json: string): Uint8Array {
  const text = new TextEncoder().encode(json);
  const bytes = new Uint8Array(12 + text.byteLength);
  bytes.set(encodeRecordingHeader(HEADER).subarray(0, 8));
  new DataView(bytes.buffer).setUint32(8, text.byteLength, true);
  bytes.set(text, 12);
  return bytes;
}

function join(...parts: Uint8Array[]): Uint8Array {
  const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let offset = 0;

  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }

  return bytes;
}

describe('recording format v1', () => {
  test('reads back exactly what it wrote', () => {
    expect(deserializeRecording(serializeRecording(RECORDING))).toEqual(RECORDING);
  });

  test('reads a recording at any offset of a larger buffer', () => {
    const bytes = serializeRecording(RECORDING);
    const padded = new Uint8Array(bytes.byteLength + 3);
    padded.set(bytes, 3);

    expect(deserializeRecording(padded.subarray(3))).toEqual(RECORDING);
  });

  test('starts with the magic and the JSON header, and checks every record', () => {
    const bytes = encodeRecordingHeader(HEADER);
    const size = new DataView(bytes.buffer).getUint32(8, true);
    const record = encodeRecordingRecord(RECORDS[5]);
    const view = new DataView(record.buffer);

    expect([...bytes.subarray(0, 8)]).toEqual([0x89, 0x4d, 0x4d, 0x52, 0x45, 0x43, 0x0d, 0x0a]);
    expect(JSON.parse(new TextDecoder().decode(bytes.subarray(12, 12 + size)))).toEqual(HEADER);
    expect([view.getUint8(0), view.getUint32(4, true)]).toEqual([6, 4]);
    expect(view.getUint32(8, true)).toBe(crc32(record.subarray(12), crc32(record.subarray(0, 8))));
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });

  test('skips records of kinds it does not know', () => {
    const payload = new Uint8Array([1, 2, 3]);
    const unknown = new Uint8Array(12);
    const view = new DataView(unknown.buffer);
    view.setUint8(0, 0x7f);
    view.setUint32(4, 3, true);
    view.setUint32(8, crc32(payload, crc32(unknown.subarray(0, 8))), true);
    const bytes = join(serializeRecording({ header: HEADER, records: [] }), unknown, payload);

    expect(deserializeRecording(bytes)).toEqual({ header: HEADER, records: [] });
  });

  test('refuses what is not a version 1 recording', () => {
    const future = withHeader(JSON.stringify({ ...HEADER, version: 2 }));
    const malformed = withHeader(JSON.stringify({ ...HEADER, schema: [{ id: 'x' }] }));

    expect(() => deserializeRecording(new Uint8Array(20))).toThrow('Not a monitor recording');
    expect(() => deserializeRecording(future)).toThrow('version 2');
    expect(() => deserializeRecording(malformed)).toThrow('malformed');
    expect(() => encodeRecordingHeader({ ...HEADER, startedAtMs: Number.NaN })).toThrow(RangeError);
  });

  test('keeps the whole records of a recording cut short or damaged at its end', () => {
    const bytes = serializeRecording(RECORDING);
    const lastStart = bytes.byteLength - encodeRecordingRecord(RECORDS.at(-1) ?? RECORDS[0]).length;
    const damaged = bytes.slice();
    damaged[damaged.byteLength - 1] ^= 0xff;

    for (const cut of [
      bytes.subarray(0, bytes.byteLength - 5),
      bytes.subarray(0, lastStart + 7),
      damaged,
    ]) {
      const read = deserializeRecording(cut);

      expect(read.records).toEqual(RECORDS.slice(0, -1));
      expect(read.truncatedAt).toBe(lastStart);
      expect(read.damaged).toBeUndefined();
    }

    expect(deserializeRecording(bytes).truncatedAt).toBeUndefined();
  });

  test('skips a damaged record in the middle and says where', () => {
    const header = encodeRecordingHeader(HEADER);
    const records = RECORDS.map((record) => encodeRecordingRecord(record));
    records[2][20] ^= 0x01;
    const read = deserializeRecording(join(header, ...records));

    expect(read.records).toEqual(RECORDS.filter((_, index) => index !== 2));
    expect(read.damaged).toEqual([
      {
        offset: header.byteLength + records[0].byteLength + records[1].byteLength,
        reason: 'check mismatch',
      },
    ]);
  });

  test('checks the kind and size of a record too, and finds the next record after them', () => {
    const header = encodeRecordingHeader(HEADER);
    const offsetOf = (records: readonly Uint8Array[], index: number) =>
      header.byteLength + records.slice(0, index).reduce((sum, record) => sum + record.length, 0);

    for (const damage of [
      (record: Uint8Array) => {
        record[0] = RECORD_KIND_BOUNDARY;
      },
      (record: Uint8Array) => {
        new DataView(record.buffer).setUint32(4, 5, true);
      },
      (record: Uint8Array) => {
        new DataView(record.buffer).setUint32(4, 0xffff, true);
      },
    ]) {
      const records = RECORDS.map((record) => encodeRecordingRecord(record));
      damage(records[1]);
      const read = deserializeRecording(join(header, ...records));

      expect(read.records).toEqual(RECORDS.filter((_, index) => index !== 1));
      expect(read.damaged).toEqual([{ offset: offsetOf(records, 1), reason: 'check mismatch' }]);
      expect(read.truncatedAt).toBeUndefined();
    }
  });

  test('finds a record after the damage even when the one after it is damaged too', () => {
    const header = encodeRecordingHeader(HEADER);
    const records = RECORDS.map((record) => encodeRecordingRecord(record));
    records[1][20] ^= 0x01;
    records[3][0] = 0xee;
    const read = deserializeRecording(join(header, ...records));

    expect(read.records).toEqual(RECORDS.filter((_, index) => index !== 1 && index !== 3));
    expect(read.damaged?.map((damage) => damage.reason)).toEqual([
      'check mismatch',
      'check mismatch',
    ]);
  });

  test('checks few candidates while scanning past damage in zeros', () => {
    const zeros = new Uint8Array(64 * 1024);
    const records = RECORDS.map((record) => encodeRecordingRecord(record));
    const bytes = join(encodeRecordingHeader(HEADER), records[0], zeros, ...records.slice(1));
    const started = performance.now();
    const read = scanRecording(bytes);

    expect(read.records.map((record) => record.kind)).toEqual(RECORDS.map((record) => record.kind));
    expect(read.damaged).toHaveLength(1);
    expect(performance.now() - started).toBeLessThan(250);
  });

  test('locates each record and its payload without decoding the blocks', () => {
    const header = encodeRecordingHeader(HEADER);
    const records = RECORDS.map((record) => encodeRecordingRecord(record));
    const bytes = join(header, ...records);
    const scan = scanRecording(bytes);

    expect(scan.validEnd).toBe(bytes.byteLength);
    expect(scan.records[1]).toMatchObject({
      kind: 'block',
      offset: header.byteLength + records[0].byteLength,
    });
    expect(peekBlock(scan.records[1].payload)).toEqual({
      ref: { epochId: 1, index: 0 },
      length: 4,
    });
    expect({ kind: 'block', block: decodeBlock(scan.records[1].payload) }).toEqual(RECORDS[1]);
  });

  test('takes a damaged size in the last record as where the recording was cut', () => {
    const records = RECORDS.map((record) => encodeRecordingRecord(record));
    const last = records.at(-1) ?? records[0];
    new DataView(last.buffer).setUint32(4, 1, true);
    const bytes = join(encodeRecordingHeader(HEADER), ...records);
    const read = deserializeRecording(bytes);

    expect(read.records).toEqual(RECORDS.slice(0, -1));
    expect(read.truncatedAt).toBe(bytes.byteLength - last.byteLength);
    expect(read.damaged).toBeUndefined();
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
    const bogus = JSON.parse('{"kind":"boundary","boundary":{"kind":"bogus","timeUs":0}}');

    expect(() => encodeRecordingRecord(bogus)).toThrow('Unknown boundary kind');
    expect(() => decodeBlock(new Uint8Array(12))).toThrow('early');
  });

  test('turns ingestion events into the records a recorder writes', () => {
    expect(recordOf({ type: 'epoch-closed', epochId: 4 })).toEqual({
      kind: 'epoch-closed',
      epochId: 4,
    });
    expect(
      recordOf({ type: 'boundary', boundary: { kind: 'reboot', timeUs: 2 ** 40 + 1 } })
    ).toEqual(RECORDS[3]);
  });

  test('encodes blocks for the in-memory persistence layer as copies', async () => {
    const block = RECORDS[1];

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
