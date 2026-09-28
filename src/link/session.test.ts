import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import {
  decodeAccess,
  encodeFrame,
  FrameReader,
  MessageType,
  TypeCode,
  Writer,
  type Frame,
} from '../protocol';
import { CommandResult } from './messages';
import { RobotError, SessionError, TimeoutError } from './errors';
import { MemorySchemaCache, type SchemaCache, type SchemaEntry } from './schema';
import { Session } from './session';
import type { SampleEvent, SessionState, SessionTiming } from './session-types';
import { BaseTransport } from './transport';

const HASH = 0x1234abcd;
const LOOP_TIME_US = 125;

const SCHEMA: SchemaEntry[] = [
  { id: 0, name: 'x', type: TypeCode.F32, access: decodeAccess(0x01) },
  { id: 1, name: 'n', type: TypeCode.U16, access: decodeAccess(0x01) },
];

const TIMING: Partial<SessionTiming> = {
  helloTimeoutMs: 100,
  helloAttempts: 3,
  requestTimeoutMs: 100,
  pingIntervalMs: 100,
  silenceTimeoutMs: 500,
  minStallMs: 10_000,
  statsIntervalMs: 10_000,
};

/** A transport the test plays the robot on, frame by frame. */
class ScriptedTransport extends BaseTransport {
  private readonly reader = new FrameReader();
  readonly sent: Frame[] = [];

  open(): void {
    this.setState({ kind: 'open' });
  }

  send(bytes: Uint8Array): void {
    this.sent.push(...this.reader.push(bytes));
  }

  close(): void {
    this.setState({ kind: 'closed', reason: 'closed-by-user' });
  }

  drop(): void {
    this.setState({ kind: 'closed', reason: 'lost', retryInMs: 250 });
  }

  robotSends(type: MessageType, payload: Uint8Array): void {
    this.receive(encodeFrame(type, payload));
  }

  sentOf(type: MessageType): Frame[] {
    return this.sent.filter((frame) => frame.type === type);
  }
}

function helloAck(version = 1): Uint8Array {
  return new Writer().u8(version).u32(HASH).u16(SCHEMA.length).u32(LOOP_TIME_US).u16(256).done();
}

function sample(group: number, seq: number, timestampUs: number, x: number, n: number) {
  return new Writer().u8(group).u16(seq).u32(timestampUs).f32(x).u16(n).done();
}

function schemaPage(first: number, count: number): Uint8Array {
  const writer = new Writer().u32(HASH).u16(first).u16(SCHEMA.length).u8(count);

  for (const entry of SCHEMA.slice(first, first + count)) {
    const name = new TextEncoder().encode(entry.name);
    writer.u8(entry.type).u8(0x01).u8(name.length).raw(name);
  }

  return writer.done();
}

function groupAck(group: number, period: number, size: number): Uint8Array {
  return new Writer().u8(group).u16(period).u16(size).done();
}

function setup(
  options: { cached?: boolean; timing?: Partial<SessionTiming>; cache?: SchemaCache } = {}
) {
  const transport = new ScriptedTransport();
  const schemaCache = options.cache ?? new MemorySchemaCache();

  if (options.cached ?? true) {
    schemaCache.store(HASH, SCHEMA);
  }

  const session = new Session(transport, {
    schemaCache,
    timing: { ...TIMING, ...options.timing },
  });
  const states: SessionState[] = [];
  const samples: SampleEvent[] = [];
  const errors: string[] = [];

  session.on('state', (state) => states.push(state));
  session.on('sample', (event) => samples.push(event));
  session.on('protocolError', (error) => errors.push(error.message));

  return { transport, session, states, samples, errors };
}

async function streaming(options: Parameters<typeof setup>[0] = {}) {
  const context = setup(options);
  context.session.open();
  context.transport.robotSends(MessageType.HELLO_ACK, helloAck());
  await vi.advanceTimersByTimeAsync(0);
  return context;
}

async function withGroup(options: Parameters<typeof setup>[0] = {}) {
  const context = await streaming(options);
  const epochs = context.session.setGroups([{ variableIds: [0, 1], periodTicks: 8 }]);

  context.transport.robotSends(MessageType.GROUP_ACK, groupAck(0, 8, 6));
  await vi.advanceTimersByTimeAsync(0);
  context.transport.robotSends(MessageType.GROUP_ACK, groupAck(0, 8, 6));
  const [epoch] = await epochs;

  return { ...context, epoch };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('handshake', () => {
  test('retries HELLO and gives up after the configured attempts', async () => {
    const { transport, session } = setup();

    session.open();
    await vi.advanceTimersByTimeAsync(299);
    expect(transport.sentOf(MessageType.HELLO)).toHaveLength(3);

    await vi.advanceTimersByTimeAsync(1);
    expect(session.state).toMatchObject({ kind: 'error' });

    session.restart();
    expect(session.state).toMatchObject({ kind: 'handshaking', reason: 'restart', attempt: 1 });
  });

  test('refuses a robot that speaks another protocol version', () => {
    const { transport, session } = setup();

    session.open();
    transport.robotSends(MessageType.HELLO_ACK, helloAck(2));

    expect(session.state.kind).toBe('error');
    expect(session.state.kind === 'error' && session.state.error.message).toContain('protocol 2');
  });

  test('skips the schema when the cache has it', async () => {
    const { session, states } = await streaming();

    expect(states.map((state) => state.kind)).toEqual(['handshaking', 'streaming']);
    expect(session.schema).toBe(SCHEMA);
  });
});

describe('keepalive', () => {
  test('a silent robot gets a fresh handshake', async () => {
    const { session } = await streaming();

    await vi.advanceTimersByTimeAsync(600);

    expect(session.state).toMatchObject({ kind: 'handshaking', reason: 'keepalive' });
  });

  test('a lost PONG is not silence when other frames arrive', async () => {
    const { transport, session } = await streaming();

    const talking = setInterval(
      () => transport.robotSends(MessageType.LOG, new Writer().u8(1).done()),
      100
    );
    await vi.advanceTimersByTimeAsync(1000);
    clearInterval(talking);

    expect(session.state.kind).toBe('streaming');
    expect(transport.sentOf(MessageType.PING).length).toBeGreaterThan(1);
  });

  test('measures the round trip of PING', async () => {
    const { transport, session } = await streaming();

    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(7);
    transport.robotSends(MessageType.PONG, new Uint8Array(0));
    await vi.advanceTimersByTimeAsync(0);

    expect(session.stats.rttMs).toBe(7);
  });
});

describe('credit', () => {
  test('is not given for frames that arrive before HELLO_ACK', async () => {
    const { transport, session } = setup();

    session.open();
    for (let seq = 0; seq < 10; seq++) {
      transport.robotSends(MessageType.SAMPLE, sample(0, seq, seq, 0, 0));
    }
    await vi.advanceTimersByTimeAsync(50);

    expect(transport.sentOf(MessageType.CREDIT)).toHaveLength(0);
  });

  test('is given back for intact metered frames only, coalesced', async () => {
    const { transport } = await withGroup();

    transport.robotSends(MessageType.SAMPLE, sample(0, 0, 0, 1, 1));
    transport.robotSends(MessageType.LOG, new Writer().u8(1).raw(new Uint8Array(80)).done());
    expect(transport.sentOf(MessageType.CREDIT)).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(10);

    const credits = transport.sentOf(MessageType.CREDIT);
    expect(credits).toHaveLength(1);
    expect([...credits[0].payload]).toEqual([18, 0]);
  });

  test('is never sent once the transport dropped', async () => {
    const { transport } = await withGroup();

    transport.robotSends(MessageType.SAMPLE, sample(0, 0, 0, 1, 1));
    transport.drop();
    await vi.advanceTimersByTimeAsync(50);

    expect(transport.sentOf(MessageType.CREDIT)).toHaveLength(0);
  });
});

describe('samples', () => {
  test('are decoded with the acknowledged layout, and a wrong size is an error', async () => {
    const { transport, samples, errors, epoch } = await withGroup();

    transport.robotSends(MessageType.SAMPLE, sample(0, 0, 1000, 2.5, 7));
    transport.robotSends(MessageType.SAMPLE, new Writer().u8(0).u16(1).u32(2000).u8(1).done());

    expect(samples).toEqual([{ epoch: epoch.id, seq: 0, timeUs: 1000, values: [2.5, 7] }]);
    expect(errors).toEqual([expect.stringContaining('1 bytes; 6 were acknowledged')]);
  });

  test('carry time past the u32 wrap', async () => {
    const { transport, samples } = await withGroup();

    transport.robotSends(MessageType.SAMPLE, sample(0, 0, 2 ** 32 - 500, 0, 0));
    transport.robotSends(MessageType.SAMPLE, sample(0, 1, 500, 0, 0));

    expect(samples.map((event) => event.timeUs)).toEqual([2 ** 32 - 500, 2 ** 32 + 500]);
  });

  test('a sample size the robot disagrees on is refused before any sample', async () => {
    const { transport, session, errors } = await streaming();
    const epochs = session.setGroups([{ variableIds: [0, 1], periodTicks: 8 }]);

    transport.robotSends(MessageType.GROUP_ACK, groupAck(0, 8, 8));

    await expect(epochs).rejects.toThrow('acknowledged 8 bytes');
    expect(session.openEpochs).toEqual([]);
    expect(errors).toHaveLength(1);
  });
});

test('an ERROR no request was waiting for is reported', async () => {
  const { transport, errors } = await streaming();

  transport.robotSends(MessageType.ERROR, new Writer().u8(0).u16(0x42).done());

  expect(errors).toEqual(['The robot sent UNKNOWN_TYPE (66)']);
});

describe('schema', () => {
  test('a gap between pages asks again from the first missing entry, without a new HELLO', async () => {
    const { transport, session } = setup({ cached: false });

    session.open();
    transport.robotSends(MessageType.HELLO_ACK, helloAck());
    transport.robotSends(MessageType.SCHEMA_PAGE, schemaPage(1, 1));
    transport.robotSends(MessageType.SCHEMA_PAGE, schemaPage(1, 1));

    const requests = transport.sentOf(MessageType.SCHEMA_REQUEST).map((frame) => frame.payload);
    expect(requests).toEqual([new Uint8Array([0, 0]), new Uint8Array([0, 0])]);

    transport.robotSends(MessageType.SCHEMA_PAGE, schemaPage(0, 2));
    await vi.advanceTimersByTimeAsync(0);

    expect(session.state.kind).toBe('streaming');
    expect(session.schema?.map((entry) => entry.name)).toEqual(['x', 'n']);
    expect(transport.sentOf(MessageType.HELLO)).toHaveLength(1);
  });

  test('running out of schema attempts is an error that restart recovers from', async () => {
    const { transport, session } = setup({
      cached: false,
      timing: { schemaTimeoutMs: 50, schemaAttempts: 2 },
    });
    const answerHello = () => transport.robotSends(MessageType.HELLO_ACK, helloAck());

    session.open();
    answerHello();
    await vi.advanceTimersByTimeAsync(50);
    answerHello();
    await vi.advanceTimersByTimeAsync(50);
    answerHello();

    expect(session.state).toMatchObject({ kind: 'error' });

    session.restart();
    answerHello();

    expect(session.state.kind).toBe('loadingSchema');
    expect(transport.sentOf(MessageType.SCHEMA_REQUEST)).toHaveLength(3);
  });

  test('a cache that throws is a miss, reported, not a hang', async () => {
    const cache: SchemaCache = {
      load: () => {
        throw new Error('quota');
      },
      store: () => {
        throw new Error('quota');
      },
    };
    const { transport, session, errors } = setup({ cached: false, cache });

    session.open();
    transport.robotSends(MessageType.HELLO_ACK, helloAck());
    transport.robotSends(MessageType.SCHEMA_PAGE, schemaPage(0, 2));
    await vi.advanceTimersByTimeAsync(0);

    expect(session.state.kind).toBe('streaming');
    expect(errors).toEqual([
      expect.stringContaining('Reading the schema cache failed'),
      expect.stringContaining('Keeping the schema in the cache failed'),
    ]);
  });
});

describe('groups', () => {
  test('a later layout supersedes one still being configured', async () => {
    const { transport, session } = await streaming();
    const first = session
      .setGroups([{ variableIds: [0], periodTicks: 8 }])
      .catch((error: unknown) => error);
    const second = session.setGroups([{ variableIds: [0, 1], periodTicks: 8 }]);

    transport.robotSends(MessageType.GROUP_ACK, groupAck(0, 8, 4));
    await vi.advanceTimersByTimeAsync(0);
    transport.robotSends(MessageType.GROUP_ACK, groupAck(0, 8, 4));
    await vi.advanceTimersByTimeAsync(0);
    transport.robotSends(MessageType.GROUP_ACK, groupAck(0, 8, 6));
    await vi.advanceTimersByTimeAsync(0);
    transport.robotSends(MessageType.GROUP_ACK, groupAck(0, 8, 6));

    expect(await first).toMatchObject({ reason: 'superseded' });
    expect(await second).toMatchObject([{ variableIds: [0, 1], sampleSize: 6 }]);
    expect(transport.sentOf(MessageType.GROUP_DEFINE)).toHaveLength(2);
  });

  test('a layout asked for while an older one fails is still applied', async () => {
    const { transport, session } = await streaming();
    const first = session
      .setGroups([{ variableIds: [0], periodTicks: 8 }])
      .catch((error: unknown) => error);
    const second = session.setGroups([{ variableIds: [1], periodTicks: 8 }]);

    transport.robotSends(MessageType.ERROR, new Writer().u8(4).u16(0).done());
    await vi.advanceTimersByTimeAsync(0);
    transport.robotSends(MessageType.GROUP_ACK, groupAck(0, 8, 2));
    await vi.advanceTimersByTimeAsync(0);
    transport.robotSends(MessageType.GROUP_ACK, groupAck(0, 8, 2));

    expect(await first).toMatchObject({ reason: 'superseded' });
    expect(await second).toMatchObject([{ variableIds: [1] }]);
  });

  test('a handshake in the middle of configuring applies the layout again after it', async () => {
    const { transport, session } = await streaming();
    const epochs = session.setGroups([{ variableIds: [0, 1], periodTicks: 8 }]);

    session.restart();
    transport.robotSends(MessageType.GROUP_ACK, groupAck(0, 8, 6));
    transport.robotSends(MessageType.HELLO_ACK, helloAck());
    await vi.advanceTimersByTimeAsync(0);
    transport.robotSends(MessageType.GROUP_ACK, groupAck(0, 8, 6));
    await vi.advanceTimersByTimeAsync(0);
    transport.robotSends(MessageType.GROUP_ACK, groupAck(0, 8, 6));

    expect(await epochs).toHaveLength(1);
    expect(transport.sentOf(MessageType.GROUP_DEFINE)).toHaveLength(2);
    expect(session.state.kind).toBe('streaming');
  });

  test('a group the robot refuses is dropped, and the others are applied', async () => {
    const { transport, session } = await streaming();
    const epochs = session.setGroups([
      { variableIds: [0], periodTicks: 8 },
      { variableIds: [1], periodTicks: 8 },
    ]);

    transport.robotSends(MessageType.ERROR, new Writer().u8(4).u16(0).done());
    await vi.advanceTimersByTimeAsync(0);
    transport.robotSends(MessageType.GROUP_ACK, groupAck(1, 8, 2));
    await vi.advanceTimersByTimeAsync(0);
    transport.robotSends(MessageType.GROUP_ACK, groupAck(1, 8, 2));

    await expect(epochs).rejects.toBeInstanceOf(RobotError);
    expect(session.openEpochs.map((epoch) => epoch.group)).toEqual([1]);
  });

  test('no samples for too long while a group streams is a stall', async () => {
    const { session } = await withGroup({ timing: { minStallMs: 200, silenceTimeoutMs: 10_000 } });

    await vi.advanceTimersByTimeAsync(260);

    expect(session.state).toMatchObject({ kind: 'handshaking', reason: 'stall' });
    expect(session.openEpochs).toEqual([]);
  });

  test('close fails a layout still waiting', async () => {
    const { session } = await streaming();
    const epochs = session
      .setGroups([{ variableIds: [0], periodTicks: 8 }])
      .catch((error: unknown) => error);

    session.close();

    expect(await epochs).toBeInstanceOf(SessionError);
  });
});

describe('requests', () => {
  test('a write the robot never answers fails, and stops being pending', async () => {
    const { session } = await streaming();
    const written = session.write(0, 1.5).catch((error: unknown) => error);

    expect(session.pendingWrite(0)).toBe(1.5);
    await vi.advanceTimersByTimeAsync(100);

    expect(await written).toBeInstanceOf(TimeoutError);
    expect(session.pendingWrite(0)).toBeUndefined();
  });

  test('a command resolves with what the robot answered', async () => {
    const { transport, session } = await streaming();
    const result = session.command(3, 9);

    transport.robotSends(MessageType.COMMAND_ACK, new Writer().u8(3).u8(2).done());

    expect(await result).toBe(CommandResult.REFUSED);
    expect([...transport.sentOf(MessageType.COMMAND)[0].payload]).toEqual([3, 9, 0, 0, 0]);
  });

  test('a read the robot refuses fails with the reason', async () => {
    const { transport, session } = await streaming();
    const value = session.read(1);

    transport.robotSends(MessageType.ERROR, new Writer().u8(5).u16(1).done());

    await expect(value).rejects.toMatchObject({ code: 5, context: 1 });
  });
});
