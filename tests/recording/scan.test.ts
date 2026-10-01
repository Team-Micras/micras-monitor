import { describe, expect, test } from 'vitest';

import { decodeBlock, encodeRecordingHeader, peekBlock } from '@/recording/codec';
import { crc32 } from '@/recording/crc32';
import { encodeRecordingRecord, scanRecording } from '@/recording/scan';
import { deserializeRecording, serializeRecording } from '@tests/support/recording/recording-bytes';
import { HEADER, RECORDING, RECORDS, join } from '@tests/support/recording/sample-recording';

const RECORD_KIND_BOUNDARY = 4;

describe('the records of a recording', () => {
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
      ref: { runId: 1, index: 0 },
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
});
