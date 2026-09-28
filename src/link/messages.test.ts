import { describe, expect, test } from 'vitest';

import { FRAME_VECTORS, type FrameVector } from '../protocol/fixtures/frame-vectors';
import { MessageType, TypeCode, writeValue } from '../protocol';
import {
  decodeMessage,
  encodeCredit,
  encodeGroupDefine,
  encodeHello,
  encodeSchemaRequest,
  encodeWrite,
} from './messages';

function vector(name: string): FrameVector {
  const found = FRAME_VECTORS.find((candidate) => candidate.name === name);

  if (!found) {
    throw new Error(`No frame vector named ${name}`);
  }

  return found;
}

describe('encoders against the firmware vectors', () => {
  test.each([
    ['hello', () => encodeHello()],
    ['schema_request', () => encodeSchemaRequest(0)],
    ['group_define', () => encodeGroupDefine(0, 80, [0, 1])],
    ['credit', () => encodeCredit(256)],
    ['write', () => encodeWrite(2, writeValue(1, TypeCode.F32))],
  ])('%s', (name, encode) => {
    expect([...encode()]).toEqual(vector(name).frame);
  });
});

describe('decodeMessage', () => {
  test('reads a HELLO_ACK the firmware produced', () => {
    const { type, payload } = vector('hello_ack');

    expect(decodeMessage({ type, payload: new Uint8Array(payload) })).toEqual({
      type: MessageType.HELLO_ACK,
      version: 1,
      schemaHash: 0xf7737285,
      variableCount: 4,
      loopTimeUs: 125,
      initialCredit: 256,
    });
  });

  test('refuses a payload too short for its type', () => {
    expect(decodeMessage({ type: MessageType.GROUP_ACK, payload: new Uint8Array(3) })).toBeNull();
  });

  test('refuses a schema entry whose name runs past the page', () => {
    const page = new Uint8Array([0, 0, 0, 0, 0, 0, 1, 0, 1, TypeCode.F32, 1, 10, 97]);

    expect(decodeMessage({ type: MessageType.SCHEMA_PAGE, payload: page })).toBeNull();
  });

  test('refuses a type only the monitor sends', () => {
    expect(decodeMessage({ type: MessageType.HELLO, payload: new Uint8Array(0) })).toBeNull();
  });
});
