import { describe, expect, test } from 'vitest';

import { vectorNamed } from '@tests/support/protocol/frame-vectors';
import { CommandResult, MessageType, Severity, TypeCode, Writer, writeValue } from '@/protocol';
import {
  creditPayload,
  decodeMessage,
  encodeCommand,
  encodeCredit,
  encodeGroupDefine,
  encodeHello,
  encodeSchemaRequest,
  encodeWrite,
  isSupported,
} from '@/link/messages';

function decodeVector(name: string) {
  const { type, payload } = vectorNamed(name);

  return decodeMessage({ type, payload: new Uint8Array(payload) });
}

describe('encoders against the firmware vectors', () => {
  test.each([
    ['hello', () => encodeHello()],
    ['schema_request', () => encodeSchemaRequest(0)],
    ['group_define', () => encodeGroupDefine(0, 80, [0, 1])],
    ['credit', () => encodeCredit(creditPayload(74565))],
    ['credit_wrapped', () => encodeCredit(creditPayload(2 ** 32 - 240))],
    ['credit_wrapped', () => encodeCredit(creditPayload(-240))],
    ['write', () => encodeWrite(2, writeValue(1, TypeCode.F32))],
    ['command', () => encodeCommand(5, 0)],
  ])('%s', (name, encode) => {
    expect(Array.from(encode())).toEqual(vectorNamed(name).frame);
  });
});

describe('decoders against the firmware vectors', () => {
  test('HELLO_ACK, with its boot id and name', () => {
    expect(decodeVector('hello_ack')).toEqual({
      type: MessageType.HELLO_ACK,
      version: 2,
      schemaHash: 4151538309,
      variableCount: 4,
      loopTimeUs: 125,
      creditWindow: 256,
      bootId: 305419896,
      robotName: 'micras',
    });
  });

  test('SCHEMA_PAGE, with the type tag of a blob only', () => {
    expect(decodeVector('schema_page')).toEqual({
      type: MessageType.SCHEMA_PAGE,
      schemaHash: 4151538309,
      first: 0,
      total: 2,
      entries: [
        { type: TypeCode.U8, access: 1, name: 'state', typeTag: null },
        { type: TypeCode.BLOB, access: 8, name: 'maze', typeTag: 'maze-grid' },
      ],
    });
  });

  test.each([
    ['command_ack', 5, CommandResult.DEFERRED, 2],
    ['command_ack_refused', 0, CommandResult.REFUSED, 1],
  ])('%s', (name, code, result, reason) => {
    expect(decodeVector(name)).toEqual({ type: MessageType.COMMAND_ACK, code, result, reason });
  });

  test('LOG, with its timestamp', () => {
    expect(decodeVector('log')).toEqual({
      type: MessageType.LOG,
      severity: Severity.INFO,
      timestampUs: 123456,
      text: 'state RUN',
    });
  });

  test('PONG, with the total the robot sent', () => {
    expect(decodeVector('pong')).toEqual({ type: MessageType.PONG, sentTotal: 1024 });
  });
});

describe('decodeMessage', () => {
  test('reads only the version of a HELLO_ACK of protocol version 1', () => {
    const v1 = new Writer().u8(1).u32(0xf7737285).u16(4).u32(125).u16(256).done();
    const ack = decodeMessage({ type: MessageType.HELLO_ACK, payload: v1 });

    expect(ack).toEqual({ type: MessageType.HELLO_ACK, version: 1 });
    expect(isSupported({ type: MessageType.HELLO_ACK, version: 1 })).toBe(false);
    expect(isSupported({ type: MessageType.HELLO_ACK, version: 2 })).toBe(true);
  });

  test('refuses a payload too short for its type', () => {
    expect(decodeMessage({ type: MessageType.GROUP_ACK, payload: new Uint8Array(3) })).toBeNull();
    expect(decodeMessage({ type: MessageType.PONG, payload: new Uint8Array(0) })).toBeNull();
  });

  test('refuses a schema entry whose name runs past the page', () => {
    const page = new Uint8Array([0, 0, 0, 0, 0, 0, 1, 0, 1, TypeCode.F32, 1, 10, 97]);

    expect(decodeMessage({ type: MessageType.SCHEMA_PAGE, payload: page })).toBeNull();
  });

  test('refuses a blob entry whose type tag runs past the page', () => {
    const page = new Uint8Array([0, 0, 0, 0, 0, 0, 1, 0, 1, TypeCode.BLOB, 8, 1, 97, 4, 109]);

    expect(decodeMessage({ type: MessageType.SCHEMA_PAGE, payload: page })).toBeNull();
  });

  test('refuses a type only the monitor sends', () => {
    expect(decodeMessage({ type: MessageType.HELLO, payload: new Uint8Array(0) })).toBeNull();
  });
});
