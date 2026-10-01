import { describe, expect, test } from 'vitest';

import {
  decodeBlock,
  encodeBlock,
  encodeRecordingHeader,
  RECORDING_FORMAT_VERSION,
} from '@/recording/codec';
import { encodeRecordingRecord } from '@/recording/scan';
import { MemoryBlockBacking } from '@tests/support/history/memory-backing';
import { deserializeRecording, serializeRecording } from '@tests/support/recording/recording-bytes';
import { HEADER, RECORDING, RECORDS, STREAM } from '@tests/support/recording/sample-recording';

function withHeader(json: string): Uint8Array {
  const text = new TextEncoder().encode(json);
  const bytes = new Uint8Array(12 + text.byteLength);
  bytes.set(encodeRecordingHeader(HEADER).subarray(0, 8));
  new DataView(bytes.buffer).setUint32(8, text.byteLength, true);
  bytes.set(text, 12);
  return bytes;
}

describe('recording format v2', () => {
  test('reads back exactly what it wrote', () => {
    expect(deserializeRecording(serializeRecording(RECORDING))).toEqual(RECORDING);
  });

  test('reads a recording at any offset of a larger buffer', () => {
    const bytes = serializeRecording(RECORDING);
    const padded = new Uint8Array(bytes.byteLength + 3);
    padded.set(bytes, 3);

    expect(deserializeRecording(padded.subarray(3))).toEqual(RECORDING);
  });

  test('refuses what is not a recording, or has a malformed header', () => {
    const malformed = withHeader(JSON.stringify({ ...HEADER, schema: [{ id: 'x' }] }));
    const coded = withHeader(
      JSON.stringify({ ...HEADER, schema: [{ id: 0, name: 'x', type: 9, access: STREAM }] })
    );

    expect(() => deserializeRecording(new Uint8Array(20))).toThrow('Not a monitor recording');
    expect(() => deserializeRecording(malformed)).toThrow('malformed');
    expect(() => deserializeRecording(coded)).toThrow('malformed');
    expect(() => encodeRecordingHeader({ ...HEADER, startedAtMs: Number.NaN })).toThrow(RangeError);
  });

  test('refuses a recording of any other version, saying which it is', () => {
    const older = withHeader(
      JSON.stringify({
        ...HEADER,
        version: 1,
        schema: [{ id: 0, name: 'odometry/velocity', type: 9, access: 1 }],
      })
    );
    const newer = withHeader(JSON.stringify({ ...HEADER, version: RECORDING_FORMAT_VERSION + 1 }));

    expect(RECORDING_FORMAT_VERSION).toBe(2);
    expect(() => deserializeRecording(older)).toThrow(
      'The recording is in format version 1; this monitor reads only version 2'
    );
    expect(() => deserializeRecording(newer)).toThrow(
      'The recording is in format version 3; this monitor reads only version 2'
    );
  });

  test('refuses values that do not fit the layout', () => {
    expect(() =>
      encodeBlock({
        ref: { runId: -1, index: 0 },
        startSample: 0,
        time: new Float64Array(0),
        columns: [],
      })
    ).toThrow(RangeError);
    const bogus = JSON.parse('{"kind":"boundary","boundary":{"kind":"bogus","timeUs":0}}');

    expect(() => encodeRecordingRecord(bogus)).toThrow('Unknown boundary kind');
    expect(() => decodeBlock(new Uint8Array(12))).toThrow('early');
  });

  test('encodes blocks for the in-memory persistence layer as copies', async () => {
    const block = RECORDS[1];

    if (block.kind !== 'block') {
      throw new Error('The second record is a block');
    }

    const persistence = new MemoryBlockBacking();
    await persistence.write(block.block);
    const back = await persistence.read(block.block.ref);

    expect(back).toEqual(block.block);
    expect(back.time).not.toBe(block.block.time);
    expect(decodeBlock(encodeBlock(back))).toEqual(back);
    await expect(persistence.read({ runId: 9, index: 0 })).rejects.toThrow('No block');
  });
});
