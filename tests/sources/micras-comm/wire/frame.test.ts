import { describe, expect, test } from 'vitest';

import {
  FRAME_VECTORS,
  vectorNamed,
  VECTORS_PROTOCOL_VERSION,
  type FrameVector,
} from '@tests/support/sources/micras-comm/frame-vectors';
import {
  encodeFrame,
  FrameReader,
  PayloadReader,
  PayloadWriter,
} from '@/sources/micras-comm/wire/frame';
import {
  MAX_FRAME_SIZE,
  MAX_PAYLOAD_SIZE,
  MessageType,
  PROTOCOL_VERSION,
} from '@/sources/micras-comm/wire/constants';

function encodeVector(vector: FrameVector): Uint8Array {
  return encodeFrame(vector.type, new Uint8Array(vector.payload));
}

describe('frames against the firmware', () => {
  test('the vectors are of the protocol version this monitor speaks', () => {
    expect(VECTORS_PROTOCOL_VERSION).toBe(PROTOCOL_VERSION);
  });

  test.each(FRAME_VECTORS)('$name encodes to the bytes the firmware produces', (vector) => {
    expect([...encodeVector(vector)]).toEqual(vector.frame);
  });

  test.each(FRAME_VECTORS)('$name decodes the firmware bytes to one message', (vector) => {
    const frames = new FrameReader().push(new Uint8Array(vector.frame));

    expect(frames).toHaveLength(1);
    expect(frames[0].type).toBe(vector.type);
    expect([...frames[0].payload]).toEqual(vector.payload);
  });
});

describe('FrameReader', () => {
  test('discards a truncated frame on its own and still delivers the next one', () => {
    const good = encodeVector(vectorNamed('group_define'));
    const torn = good.slice(0, good.length - 3);
    const reader = new FrameReader();

    const frames = reader.push(new Uint8Array([...torn, 0x00, ...good]));

    expect(frames).toHaveLength(1);
    expect(reader.discarded).toBe(1);
  });

  test('discards a frame whose check does not match', () => {
    const corrupted = encodeVector(vectorNamed('write'));
    corrupted[6] ^= 0x10;
    const reader = new FrameReader();

    expect(reader.push(corrupted)).toEqual([]);
    expect(reader.discarded).toBe(1);
  });

  test('discards a frame too short to hold a type and a check', () => {
    const reader = new FrameReader();

    expect(reader.push(new Uint8Array([0x02, 0x01, 0x00]))).toEqual([]);
    expect(reader.discarded).toBe(1);
  });

  test('ignores empty frames between delimiters', () => {
    const reader = new FrameReader();

    expect(reader.push(new Uint8Array([0x00, 0x00, 0x00]))).toEqual([]);
    expect(reader.discarded).toBe(0);
  });

  test('joins a frame split across pushes', () => {
    const frame = encodeVector(vectorNamed('hello_ack'));
    const reader = new FrameReader();

    expect(reader.push(frame.subarray(0, 5))).toEqual([]);
    expect(reader.push(frame.subarray(5))).toHaveLength(1);
  });

  test('throws away a run longer than any frame without holding on to it', () => {
    const good = encodeVector(vectorNamed('group_define'));
    const reader = new FrameReader();
    const garbage = new Uint8Array(MAX_FRAME_SIZE * 4).fill(0x55);

    expect(reader.push(garbage)).toEqual([]);
    expect(reader.push(new Uint8Array([0, ...good]))).toHaveLength(1);
    expect(reader.discarded).toBe(1);
  });

  test('forgets a partial frame when cleared', () => {
    const frame = encodeVector(vectorNamed('credit'));
    const reader = new FrameReader();

    reader.push(frame.subarray(0, 3));
    reader.clear();

    expect(reader.push(frame)).toHaveLength(1);
    expect(reader.discarded).toBe(0);
  });
});

describe('encodeFrame', () => {
  test('refuses a payload larger than the protocol allows', () => {
    expect(() => encodeFrame(MessageType.SAMPLE, new Uint8Array(MAX_PAYLOAD_SIZE + 1))).toThrow(
      /exceeds/
    );
  });

  test('round trips a payload of the largest size', () => {
    const payload = new Uint8Array(MAX_PAYLOAD_SIZE).map((_, index) => index % 7);
    const frames = new FrameReader().push(encodeFrame(MessageType.SAMPLE, payload));

    expect(frames).toHaveLength(1);
    expect(frames[0].payload).toEqual(payload);
  });
});

describe('PayloadWriter and PayloadReader', () => {
  test('read back what was written, little endian', () => {
    const payload = new PayloadWriter()
      .u8(0xab)
      .u16(0x1234)
      .u32(0xdeadbeef)
      .f32(1.5)
      .raw(new TextEncoder().encode('ok'))
      .done();
    const reader = new PayloadReader(payload);

    expect([...payload.subarray(1, 3)]).toEqual([0x34, 0x12]);
    expect(reader.u8()).toBe(0xab);
    expect(reader.u16()).toBe(0x1234);
    expect(reader.u32()).toBe(0xdeadbeef);
    expect(new DataView(reader.bytes(4).slice().buffer).getFloat32(0, true)).toBe(1.5);
    expect(reader.left).toBe(2);
    expect(reader.text(2)).toBe('ok');
    expect(reader.rest()).toHaveLength(0);
  });

  test('reads from a view into a larger buffer', () => {
    const buffer = new Uint8Array([0xff, 0x01, 0x02, 0xff]);

    expect(new PayloadReader(buffer.subarray(1, 3)).u16()).toBe(0x0201);
  });
});
