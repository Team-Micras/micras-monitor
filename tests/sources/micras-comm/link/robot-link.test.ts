import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import {
  CommandResult,
  decodeAccess,
  encodeFrame,
  ErrorCode,
  FrameReader,
  MessageType,
  TypeCode,
  PayloadWriter,
  type Frame,
} from '@/sources/micras-comm/wire';
import { RobotError, LinkError, TimeoutError } from '@/sources/micras-comm/link/errors';
import type { Epoch } from '@/sources/micras-comm/link/epochs';
import {
  MemorySchemaCache,
  type SchemaCache,
  type SchemaEntry,
} from '@/sources/micras-comm/link/schema';
import { wireSize } from '@/sources/micras-comm/link/messages';
import { RobotLink } from '@/sources/micras-comm/link/robot-link';
import type {
  EpochEndEvent,
  GroupsResult,
  LogEvent,
  SampleEvent,
  LinkState,
  LinkTiming,
  TimelineEvent,
} from '@/sources/micras-comm/link/link-events';
import { BaseTransport } from '@/sources/micras-comm/transports/transport';

const HASH = 0x1234abcd;
const LOOP_TIME_US = 125;

const SCHEMA: SchemaEntry[] = [
  { id: 0, name: 'x', type: TypeCode.F32, access: decodeAccess(0x01) },
  { id: 1, name: 'n', type: TypeCode.U16, access: decodeAccess(0x01) },
];

const TIMING: Partial<LinkTiming> = {
  helloTimeoutMs: 100,
  helloBackoffMaxMs: 400,
  requestTimeoutMs: 100,
  pingIntervalMs: 100,
  silenceTimeoutMs: 500,
  minStallMs: 10_000,
  statsIntervalMs: 10_000,
};

/** A transport the test plays the robot on, frame by frame. */
class ScriptedTransport extends BaseTransport {
  readonly #reader = new FrameReader();
  #answeredPings = 0;
  readonly sent: Frame[] = [];

  open(): void {
    this.setState({ kind: 'open' });
  }

  send(bytes: Uint8Array): void {
    this.sent.push(...this.#reader.push(bytes));
  }

  close(): void {
    this.setState({ kind: 'closed', reason: 'closed-by-user' });
  }

  /** Open again without the link seeing the transport close, which redoes the handshake. */
  reopen(): void {
    this.setState({ kind: 'open' });
  }

  drop(): void {
    this.setState({ kind: 'closed', reason: 'lost', retryInMs: 250 });
  }

  robotSends(type: MessageType, payload: Uint8Array): void {
    this.receive(encodeFrame(type, payload));
  }

  robotSendsBytes(bytes: Uint8Array): void {
    this.receive(bytes);
  }

  /** Answer with a PONG every PING not answered yet, as the robot does, in order. */
  answerPings(sentTotal: number): void {
    const pings = this.sentOf(MessageType.PING).length;

    for (; this.#answeredPings < pings; this.#answeredPings++) {
      this.robotSends(MessageType.PONG, pong(sentTotal));
    }
  }

  creditTotals(): number[] {
    return this.sentOf(MessageType.CREDIT).map((frame) =>
      new DataView(frame.payload.buffer, frame.payload.byteOffset).getUint32(0, true)
    );
  }

  sentOf(type: MessageType): Frame[] {
    return this.sent.filter((frame) => frame.type === type);
  }
}

const BOOT_ID = 0x5eed0001;

interface HelloAckFields {
  bootId?: number;
  hash?: number;
  count?: number;
  creditWindow?: number;
}

function helloAck(fields: HelloAckFields = {}): Uint8Array {
  const { bootId = BOOT_ID, hash = HASH, count = SCHEMA.length, creditWindow = 256 } = fields;
  const name = new TextEncoder().encode('micras');

  return new PayloadWriter()
    .u8(2)
    .u32(hash)
    .u16(count)
    .u32(LOOP_TIME_US)
    .u16(creditWindow)
    .u32(bootId)
    .u8(name.length)
    .raw(name)
    .done();
}

function helloAckV1(): Uint8Array {
  return new PayloadWriter().u8(1).u32(HASH).u16(SCHEMA.length).u32(LOOP_TIME_US).u16(256).done();
}

function log(text: string, timestampUs = 0): Uint8Array {
  return new PayloadWriter().u8(1).u32(timestampUs).raw(new TextEncoder().encode(text)).done();
}

function pong(sentTotal: number): Uint8Array {
  return new PayloadWriter().u32(sentTotal).done();
}

function sample(group: number, seq: number, timestampUs: number, x: number, n: number) {
  return new PayloadWriter().u8(group).u16(seq).u32(timestampUs).f32(x).u16(n).done();
}

function schemaPage(first: number, count: number): Uint8Array {
  const writer = new PayloadWriter().u32(HASH).u16(first).u16(SCHEMA.length).u8(count);

  for (const entry of SCHEMA.slice(first, first + count)) {
    const name = new TextEncoder().encode(entry.name);
    writer.u8(entry.type).u8(0x01).u8(name.length).raw(name);
  }

  return writer.done();
}

function groupAck(group: number, period: number, size: number): Uint8Array {
  return new PayloadWriter().u8(group).u16(period).u16(size).done();
}

function inOneBatch(...frames: [MessageType, Uint8Array][]): Uint8Array {
  const encoded = frames.map(([type, payload]) => encodeFrame(type, payload));
  const bytes = new Uint8Array(encoded.reduce((total, frame) => total + frame.length, 0));
  let offset = 0;

  for (const frame of encoded) {
    bytes.set(frame, offset);
    offset += frame.length;
  }

  return bytes;
}

function withBlobSchema(): SchemaCache {
  const cache = new MemorySchemaCache();
  cache.store(HASH, [
    ...SCHEMA,
    { id: 2, name: 'maze', type: TypeCode.BLOB, access: decodeAccess(0) },
  ]);
  return cache;
}

function setup(
  options: { cached?: boolean; timing?: Partial<LinkTiming>; cache?: SchemaCache } = {}
) {
  const transport = new ScriptedTransport();
  const schemaCache = options.cache ?? new MemorySchemaCache();

  if (options.cached ?? true) {
    schemaCache.store(HASH, SCHEMA);
  }

  const link = new RobotLink(transport, {
    schemaCache,
    timing: { ...TIMING, ...options.timing },
  });
  const states: LinkState[] = [];
  const samples: SampleEvent[] = [];
  const errors: string[] = [];

  link.on('state', (state) => states.push(state));
  link.on('sample', (event) => samples.push(event));
  link.on('protocolError', (error) => errors.push(error.message));

  return { transport, link, states, samples, errors };
}

type ConnectOptions = Parameters<typeof setup>[0] & { hello?: HelloAckFields };

async function streaming(options: ConnectOptions = {}) {
  const context = setup(options);
  context.link.open();
  context.transport.robotSends(MessageType.HELLO_ACK, helloAck(options.hello));
  await vi.advanceTimersByTimeAsync(0);
  return context;
}

async function withGroup(options: ConnectOptions = {}) {
  const context = await streaming(options);
  const epochs = context.link.setGroups([{ variableIds: [0, 1], periodTicks: 8 }]);

  context.transport.robotSends(MessageType.GROUP_ACK, groupAck(0, 8, 6));
  await vi.advanceTimersByTimeAsync(0);
  context.transport.robotSends(MessageType.GROUP_ACK, groupAck(0, 8, 6));
  const [epoch] = applied(await epochs);

  return { ...context, epoch };
}

async function pinged(options: ConnectOptions = {}) {
  const context = await withGroup(options);

  await vi.advanceTimersByTimeAsync(100);
  expect(context.transport.sentOf(MessageType.PING)).toHaveLength(1);
  return context;
}

function applied(result: GroupsResult): readonly Epoch[] {
  if (result.status !== 'applied') {
    throw new Error('The layout was superseded');
  }

  return result.epochs;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('handshake', () => {
  test('keeps sending HELLO with backoff for as long as the transport is open', async () => {
    const { transport, link } = setup();

    link.open();
    await vi.advanceTimersByTimeAsync(299);
    expect(transport.sentOf(MessageType.HELLO)).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(1);
    expect(transport.sentOf(MessageType.HELLO)).toHaveLength(3);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(transport.sentOf(MessageType.HELLO)).toHaveLength(3 + Math.floor(9700 / 400) + 1);
    expect(link.state).toMatchObject({ kind: 'handshaking', reason: 'connected' });
  });

  test('refuses a robot that speaks protocol version 1, saying what to update', async () => {
    const { transport, link } = setup();

    link.open();
    transport.robotSends(MessageType.HELLO_ACK, helloAckV1());
    await vi.advanceTimersByTimeAsync(10_000);

    expect(link.state.kind).toBe('error');
    expect(link.state.kind === 'error' && link.state.error.message).toBe(
      "The robot speaks version 1 of the link protocol and this monitor speaks version 2; update the robot's firmware to connect"
    );
    expect(transport.sentOf(MessageType.HELLO)).toHaveLength(1);
  });

  test('tells what the robot is from HELLO_ACK', async () => {
    const { link } = await streaming();

    expect(link.robot).toEqual({
      protocolVersion: 2,
      schemaHash: HASH,
      variableCount: 2,
      loopTimeUs: LOOP_TIME_US,
      creditWindow: 256,
      bootId: BOOT_ID,
      robotName: 'micras',
    });
  });

  test('skips the schema when the cache has it', async () => {
    const { link, states } = await streaming();

    expect(states.map((state) => state.kind)).toEqual(['handshaking', 'streaming']);
    expect(link.schema).toBe(SCHEMA);
  });

  test('a different schema announced later forgets the old one before any read or write', async () => {
    const { transport, link } = await streaming();

    transport.reopen();
    transport.robotSends(MessageType.HELLO_ACK, helloAck({ hash: 0xdeadbeef, count: 5 }));

    expect(link.state).toMatchObject({ kind: 'loadingSchema', total: 5 });
    expect(link.schema).toBeUndefined();
    await expect(link.write(0, 1)).rejects.toMatchObject({ reason: 'not-ready' });
    await expect(link.read(0)).rejects.toMatchObject({ reason: 'not-ready' });
    expect(transport.sentOf(MessageType.WRITE)).toEqual([]);
    expect(transport.sentOf(MessageType.READ)).toEqual([]);
  });
});

describe('keepalive', () => {
  test('a silent robot gets a fresh handshake', async () => {
    const { link } = await streaming();

    await vi.advanceTimersByTimeAsync(600);

    expect(link.state).toMatchObject({ kind: 'handshaking', reason: 'keepalive' });
  });

  test('a lost PONG is not silence when other frames arrive', async () => {
    const { transport, link } = await streaming();

    const talking = setInterval(
      () => transport.robotSends(MessageType.WRITE_ACK, new PayloadWriter().u16(9).u8(0).done()),
      100
    );
    await vi.advanceTimersByTimeAsync(1000);
    clearInterval(talking);

    expect(link.state.kind).toBe('streaming');
    expect(transport.sentOf(MessageType.PING).length).toBeGreaterThan(1);
  });

  test('measures the round trip of PING', async () => {
    const { transport, link } = await streaming();

    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(7);
    transport.robotSends(MessageType.PONG, pong(0));
    await vi.advanceTimersByTimeAsync(0);

    expect(link.stats.rttMs).toBe(7);
  });

  test('a stream quiet for half the stall threshold gets a PING early, whose PONG saves it', async () => {
    const { transport, link } = await withGroup({
      timing: { pingIntervalMs: 1000, minStallMs: 400, silenceTimeoutMs: 10_000 },
    });

    await vi.advanceTimersByTimeAsync(100);
    transport.robotSends(MessageType.PONG, pong(0));
    await vi.advanceTimersByTimeAsync(200);

    expect(transport.sentOf(MessageType.PING)).toHaveLength(2);

    transport.robotSends(MessageType.PONG, pong(18));
    transport.robotSends(MessageType.SAMPLE, sample(0, 1, 1000, 1, 1));
    await vi.advanceTimersByTimeAsync(300);

    expect(link.stats.creditRecovered).toBe(18);
    expect(link.state.kind).toBe('streaming');
  });
});

describe('credit', () => {
  test('is not given for frames that arrive before HELLO_ACK', async () => {
    const { transport, link } = setup();

    link.open();
    for (let seq = 0; seq < 10; seq++) {
      transport.robotSends(MessageType.SAMPLE, sample(0, seq, seq, 0, 0));
    }
    await vi.advanceTimersByTimeAsync(50);

    expect(transport.sentOf(MessageType.CREDIT)).toHaveLength(0);
  });

  test('is given back for intact metered frames only, coalesced', async () => {
    const { transport } = await withGroup();

    transport.robotSends(MessageType.SAMPLE, sample(0, 0, 0, 1, 1));
    transport.robotSends(
      MessageType.VALUE,
      new PayloadWriter().u16(0).raw(new Uint8Array(80)).done()
    );
    transport.robotSendsBytes(new Uint8Array([7, 7, 7, 0]));
    expect(transport.sentOf(MessageType.CREDIT)).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(10);

    const credits = transport.sentOf(MessageType.CREDIT);
    expect(credits).toHaveLength(1);
    expect(Array.from(credits[0].payload)).toEqual([18, 0, 0, 0]);
  });

  test('carries the total consumed since HELLO, so any CREDIT makes up for one lost', async () => {
    const { transport } = await withGroup();

    for (let seq = 0; seq < 8; seq++) {
      transport.robotSends(MessageType.SAMPLE, sample(0, seq, seq * 1000, 1, 1));
    }
    transport.robotSends(MessageType.LOG, log('x'.repeat(40)));
    await vi.advanceTimersByTimeAsync(10);

    expect(transport.creditTotals()).toEqual([72, 144, 144 + wireSize(45)]);
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
    transport.robotSends(
      MessageType.SAMPLE,
      new PayloadWriter().u8(0).u16(1).u32(2000).u8(1).done()
    );

    expect(samples).toEqual([
      { epoch: epoch.id, seq: 0, timeUs: 1000, values: [2.5, 7], missingBefore: 0 },
    ]);
    expect(errors).toEqual([expect.stringContaining('1 bytes; 6 were acknowledged')]);
  });

  test('carry time past the u32 wrap', async () => {
    const { transport, samples } = await withGroup();

    transport.robotSends(MessageType.SAMPLE, sample(0, 0, 2 ** 32 - 500, 0, 0));
    transport.robotSends(MessageType.SAMPLE, sample(0, 1, 500, 0, 0));

    expect(samples.map((event) => event.timeUs)).toEqual([2 ** 32 - 500, 2 ** 32 + 500]);
  });

  test('a sample size the robot disagrees on is refused before any sample', async () => {
    const { transport, link, errors } = await streaming();
    const epochs = link.setGroups([{ variableIds: [0, 1], periodTicks: 8 }]);

    transport.robotSends(MessageType.GROUP_ACK, groupAck(0, 8, 8));
    await vi.advanceTimersByTimeAsync(0);
    transport.robotSends(MessageType.GROUP_ACK, groupAck(0, 8, 8));

    await expect(epochs).rejects.toThrow('acknowledged 8 bytes');
    expect([...transport.sentOf(MessageType.GROUP_ENABLE)[0].payload]).toEqual([0, 0]);
    expect(link.openEpochs).toEqual([]);
    expect(errors).toEqual([]);
  });
});

test('an ERROR no request was waiting for is reported', async () => {
  const { transport, errors } = await streaming();

  transport.robotSends(MessageType.ERROR, new PayloadWriter().u8(0).u16(0x42).done());

  expect(errors).toEqual(['The robot sent UNKNOWN_TYPE (66)']);
});

describe('schema', () => {
  test('a gap between pages asks again from the first missing entry, without a new HELLO', async () => {
    const { transport, link } = setup({ cached: false });

    link.open();
    transport.robotSends(MessageType.HELLO_ACK, helloAck());
    transport.robotSends(MessageType.SCHEMA_PAGE, schemaPage(1, 1));
    transport.robotSends(MessageType.SCHEMA_PAGE, schemaPage(1, 1));

    const requests = transport.sentOf(MessageType.SCHEMA_REQUEST).map((frame) => frame.payload);
    expect(requests).toEqual([new Uint8Array([0, 0]), new Uint8Array([0, 0])]);

    transport.robotSends(MessageType.SCHEMA_PAGE, schemaPage(0, 2));
    await vi.advanceTimersByTimeAsync(0);

    expect(link.state.kind).toBe('streaming');
    expect(link.schema?.map((entry) => entry.name)).toEqual(['x', 'n']);
    expect(transport.sentOf(MessageType.HELLO)).toHaveLength(1);
  });

  test('schema pages that stop arriving redo the handshake, asking only for what is missing', async () => {
    const { transport, link } = setup({ cached: false, timing: { schemaTimeoutMs: 50 } });
    const answerHello = () => transport.robotSends(MessageType.HELLO_ACK, helloAck());

    link.open();
    answerHello();
    transport.robotSends(MessageType.SCHEMA_PAGE, schemaPage(0, 1));
    await vi.advanceTimersByTimeAsync(50);

    expect(link.state).toMatchObject({ kind: 'handshaking', reason: 'schema-retry' });

    answerHello();
    transport.robotSends(MessageType.SCHEMA_PAGE, schemaPage(1, 1));
    await vi.advanceTimersByTimeAsync(0);

    const requests = transport
      .sentOf(MessageType.SCHEMA_REQUEST)
      .map((frame) => Array.from(frame.payload));
    expect(requests).toEqual([
      [0, 0],
      [1, 0],
    ]);
    expect(link.state.kind).toBe('streaming');
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
    const { transport, link, errors } = setup({ cached: false, cache });

    link.open();
    transport.robotSends(MessageType.HELLO_ACK, helloAck());
    transport.robotSends(MessageType.SCHEMA_PAGE, schemaPage(0, 2));
    await vi.advanceTimersByTimeAsync(0);

    expect(link.state.kind).toBe('streaming');
    expect(errors).toEqual([
      expect.stringContaining('Reading the schema cache failed'),
      expect.stringContaining('Keeping the schema in the cache failed'),
    ]);
  });
});

describe('groups', () => {
  test('a later layout supersedes one still being configured', async () => {
    const { transport, link } = await streaming();
    const first = link
      .setGroups([{ variableIds: [0], periodTicks: 8 }])
      .catch((error: unknown) => error);
    const second = link.setGroups([{ variableIds: [0, 1], periodTicks: 8 }]);

    transport.robotSends(MessageType.GROUP_ACK, groupAck(0, 8, 4));
    await vi.advanceTimersByTimeAsync(0);
    transport.robotSends(MessageType.GROUP_ACK, groupAck(0, 8, 4));
    await vi.advanceTimersByTimeAsync(0);
    transport.robotSends(MessageType.GROUP_ACK, groupAck(0, 8, 6));
    await vi.advanceTimersByTimeAsync(0);
    transport.robotSends(MessageType.GROUP_ACK, groupAck(0, 8, 6));

    expect(await first).toEqual({ status: 'superseded' });
    expect(applied(await second)).toMatchObject([{ variableIds: [0, 1], sampleSize: 6 }]);
    expect(transport.sentOf(MessageType.GROUP_DEFINE)).toHaveLength(2);
  });

  test('a layout asked for while an older one fails is still applied', async () => {
    const { transport, link } = await streaming();
    const first = link
      .setGroups([{ variableIds: [0], periodTicks: 8 }])
      .catch((error: unknown) => error);
    const second = link.setGroups([{ variableIds: [1], periodTicks: 8 }]);

    transport.robotSends(MessageType.ERROR, new PayloadWriter().u8(4).u16(0).done());
    await vi.advanceTimersByTimeAsync(0);
    transport.robotSends(MessageType.ERROR, new PayloadWriter().u8(2).u16(0).done());
    await vi.advanceTimersByTimeAsync(0);
    transport.robotSends(MessageType.GROUP_ACK, groupAck(0, 8, 2));
    await vi.advanceTimersByTimeAsync(0);
    transport.robotSends(MessageType.GROUP_ACK, groupAck(0, 8, 2));

    expect(await first).toEqual({ status: 'superseded' });
    expect(applied(await second)).toMatchObject([{ variableIds: [1] }]);
  });

  test('a handshake in the middle of configuring applies the layout again after it', async () => {
    const { transport, link } = await streaming();
    const epochs = link.setGroups([{ variableIds: [0, 1], periodTicks: 8 }]);

    transport.reopen();
    transport.robotSends(MessageType.GROUP_ACK, groupAck(0, 8, 6));
    transport.robotSends(MessageType.HELLO_ACK, helloAck());
    await vi.advanceTimersByTimeAsync(0);
    transport.robotSends(MessageType.GROUP_ACK, groupAck(0, 8, 6));
    await vi.advanceTimersByTimeAsync(0);
    transport.robotSends(MessageType.GROUP_ACK, groupAck(0, 8, 6));

    expect(applied(await epochs)).toHaveLength(1);
    expect(transport.sentOf(MessageType.GROUP_DEFINE)).toHaveLength(2);
    expect(link.state.kind).toBe('streaming');
  });

  test('a group the robot refuses is dropped, and the others are applied', async () => {
    const { transport, link } = await streaming();
    const epochs = link.setGroups([
      { variableIds: [0], periodTicks: 8 },
      { variableIds: [1], periodTicks: 8 },
    ]);

    transport.robotSends(MessageType.ERROR, new PayloadWriter().u8(4).u16(0).done());
    await vi.advanceTimersByTimeAsync(0);
    transport.robotSends(MessageType.ERROR, new PayloadWriter().u8(2).u16(0).done());
    await vi.advanceTimersByTimeAsync(0);
    transport.robotSends(MessageType.GROUP_ACK, groupAck(1, 8, 2));
    await vi.advanceTimersByTimeAsync(0);
    transport.robotSends(MessageType.GROUP_ACK, groupAck(1, 8, 2));

    await expect(epochs).rejects.toBeInstanceOf(RobotError);
    expect(link.openEpochs.map((epoch) => epoch.group)).toEqual([1]);
  });

  test('no samples for too long while a group streams is a stall', async () => {
    const { link } = await withGroup({ timing: { minStallMs: 200, silenceTimeoutMs: 10_000 } });

    await vi.advanceTimersByTimeAsync(260);

    expect(link.state).toMatchObject({ kind: 'handshaking', reason: 'stall' });
    expect(link.openEpochs).toEqual([]);
  });

  test('close fails a layout still waiting', async () => {
    const { link } = await streaming();
    const epochs = link
      .setGroups([{ variableIds: [0], periodTicks: 8 }])
      .catch((error: unknown) => error);

    link.close();

    expect(await epochs).toBeInstanceOf(LinkError);
  });
});

describe('requests', () => {
  test('a write the robot never answers fails, and stops being pending', async () => {
    const { link } = await streaming();
    const written = link.write(0, 1.5).catch((error: unknown) => error);

    expect(link.pendingWrite(0)).toBe(1.5);
    await vi.advanceTimersByTimeAsync(100);

    expect(await written).toBeInstanceOf(TimeoutError);
    expect(link.pendingWrite(0)).toBeUndefined();
  });

  test('a command resolves with what the robot answered', async () => {
    const { transport, link } = await streaming();
    const result = link.command(3, 9);

    transport.robotSends(MessageType.COMMAND_ACK, new PayloadWriter().u8(3).u8(2).u8(1).done());

    expect(await result).toEqual({ result: CommandResult.REFUSED, reason: 1 });
    expect([...transport.sentOf(MessageType.COMMAND)[0].payload]).toEqual([3, 9, 0, 0, 0]);
  });

  test('a read the robot refuses fails with the reason', async () => {
    const { transport, link } = await streaming();
    const value = link.read(1);

    transport.robotSends(MessageType.ERROR, new PayloadWriter().u8(5).u16(1).done());

    await expect(value).rejects.toMatchObject({ code: 5, context: 1 });
  });

  test('a group definition waits for a blob READ, so a GROUP_TOO_LARGE answers only the READ', async () => {
    const { transport, link } = await streaming({
      cached: false,
      cache: withBlobSchema(),
      hello: { count: 3 },
    });
    const value = link.read(2);
    const layout = link.setGroups([{ variableIds: [0, 1], periodTicks: 8 }]);

    expect(transport.sentOf(MessageType.GROUP_DEFINE)).toEqual([]);

    transport.robotSends(
      MessageType.ERROR,
      new PayloadWriter().u8(ErrorCode.GROUP_TOO_LARGE).u16(2).done()
    );
    await expect(value).rejects.toMatchObject({ code: ErrorCode.GROUP_TOO_LARGE, context: 2 });
    await vi.advanceTimersByTimeAsync(0);
    expect(transport.sentOf(MessageType.GROUP_DEFINE)).toHaveLength(1);

    transport.robotSends(MessageType.GROUP_ACK, groupAck(0, 8, 6));
    await vi.advanceTimersByTimeAsync(0);
    transport.robotSends(MessageType.GROUP_ACK, groupAck(0, 8, 6));
    expect(applied(await layout)).toHaveLength(1);
  });

  test('a blob READ that waited through a new schema is not sent', async () => {
    const { transport, link } = await streaming({
      cached: false,
      cache: withBlobSchema(),
      hello: { count: 3 },
    });
    void link.setGroups([{ variableIds: [0, 1], periodTicks: 8 }]).catch(() => undefined);
    const outcome = link.read(2).catch((error: unknown) => error);

    transport.reopen();
    transport.robotSends(MessageType.HELLO_ACK, helloAck({ hash: 0xdeadbeef, count: 5 }));
    await vi.advanceTimersByTimeAsync(5000);

    expect(await outcome).toMatchObject({ reason: 'not-ready' });
    expect(transport.sentOf(MessageType.READ)).toEqual([]);
  });

  test('a blob READ waits for a group definition the robot has not answered', async () => {
    const { transport, link } = await streaming({
      cached: false,
      cache: withBlobSchema(),
      hello: { count: 3 },
    });
    const layout = link.setGroups([{ variableIds: [0, 1], periodTicks: 8 }]);
    const value = link.read(2);

    expect(transport.sentOf(MessageType.READ)).toEqual([]);

    transport.robotSends(MessageType.GROUP_ACK, groupAck(0, 8, 6));
    await vi.advanceTimersByTimeAsync(0);
    expect(transport.sentOf(MessageType.READ)).toHaveLength(1);

    transport.robotSends(MessageType.GROUP_ACK, groupAck(0, 8, 6));
    transport.robotSends(
      MessageType.VALUE,
      new PayloadWriter()
        .u16(2)
        .raw(new Uint8Array([1, 2, 3]))
        .done()
    );
    expect(await value).toEqual(new Uint8Array([1, 2, 3]));
    expect(applied(await layout)).toHaveLength(1);
  });
});

describe('credit resynchronized by PONG', () => {
  test('gives back at once the metered frames that never arrived', async () => {
    const { transport, link } = await pinged();

    transport.robotSends(MessageType.SAMPLE, sample(0, 0, 0, 1, 1));
    transport.robotSends(MessageType.SAMPLE, sample(0, 2, 2000, 1, 1));
    transport.robotSends(MessageType.PONG, pong(3 * 18));

    expect(transport.creditTotals()).toEqual([54]);
    expect(link.stats.creditRecovered).toBe(18);
    expect(link.state.kind).toBe('streaming');
  });

  test('a total below what already arrived redoes the handshake to set the count straight', async () => {
    const { transport, link } = await pinged();

    for (let seq = 0; seq < 3; seq++) {
      transport.robotSends(MessageType.SAMPLE, sample(0, seq, seq * 1000, 1, 1));
    }
    transport.robotSends(MessageType.PONG, pong(0));

    expect(link.state).toMatchObject({ kind: 'handshaking', reason: 'credit-resync' });
  });

  test('a loss is measured against the window the robot announced', async () => {
    const { transport, link } = await pinged({ hello: { creditWindow: 1024 } });

    transport.robotSends(MessageType.SAMPLE, sample(0, 0, 0, 1, 1));
    transport.robotSends(MessageType.PONG, pong(18 + 600));

    expect(link.stats.creditRecovered).toBe(600);
    expect(transport.creditTotals()).toEqual([618]);
    expect(link.state.kind).toBe('streaming');
  });

  test('a PONG no PING waits for is not taken', async () => {
    const { transport, link } = await withGroup();

    transport.robotSends(MessageType.PONG, pong(200));

    expect(transport.creditTotals()).toEqual([]);
    expect(link.stats.creditRecovered).toBe(0);
  });
});

describe('boots and timelines', () => {
  test('a new boot id opens a new timeline, and the layout is applied again on it', async () => {
    const { transport, link, samples, epoch } = await withGroup();
    const timelines: TimelineEvent[] = [];
    const ended: EpochEndEvent[] = [];
    link.on('timeline', (event) => timelines.push(event));
    link.on('epochEnd', (event) => ended.push(event));

    transport.robotSends(MessageType.SAMPLE, sample(0, 0, 900_000_000, 1, 1));
    transport.reopen();
    transport.robotSends(MessageType.HELLO_ACK, helloAck({ bootId: 0xb007 }));
    await vi.advanceTimersByTimeAsync(0);
    transport.robotSends(MessageType.GROUP_ACK, groupAck(0, 8, 6));
    await vi.advanceTimersByTimeAsync(0);
    transport.robotSends(MessageType.GROUP_ACK, groupAck(0, 8, 6));
    await vi.advanceTimersByTimeAsync(0);
    transport.robotSends(MessageType.SAMPLE, sample(0, 0, 1000, 1, 1));

    const [reborn] = link.openEpochs;
    expect(timelines).toEqual([{ id: epoch.timeline + 1, reason: 'reboot' }]);
    expect(ended).toEqual([{ epoch, reason: 'restarted' }]);
    expect(reborn).toMatchObject({ group: 0, timeline: epoch.timeline + 1 });
    expect(samples.at(-1)).toMatchObject({ epoch: reborn.id, timeUs: 1000 });
    expect(link.stats.clockResets).toBe(0);
  });

  test('the same boot id after a new handshake keeps the timeline', async () => {
    const { transport, link, epoch } = await withGroup();
    const timelines: TimelineEvent[] = [];
    link.on('timeline', (event) => timelines.push(event));

    transport.reopen();
    transport.robotSends(MessageType.HELLO_ACK, helloAck());
    await vi.advanceTimersByTimeAsync(0);
    transport.robotSends(MessageType.GROUP_ACK, groupAck(0, 8, 6));
    await vi.advanceTimersByTimeAsync(0);
    transport.robotSends(MessageType.GROUP_ACK, groupAck(0, 8, 6));
    await vi.advanceTimersByTimeAsync(0);

    expect(timelines).toEqual([]);
    expect(link.openEpochs[0]).toMatchObject({ timeline: epoch.timeline });
    expect(link.openEpochs[0].id).not.toBe(epoch.id);
  });

  test('an epoch enabled in the batch that shows a clock reset is announced on the new timeline', async () => {
    const { transport, link, samples, epoch } = await withGroup();
    const timelines: TimelineEvent[] = [];
    link.on('timeline', (event) => timelines.push(event));

    transport.robotSends(MessageType.SAMPLE, sample(0, 0, 7_000_000, 1, 1));
    const layout = link.setGroups([
      { variableIds: [0, 1], periodTicks: 8 },
      { variableIds: [0, 1], periodTicks: 8 },
    ]);
    transport.robotSends(MessageType.GROUP_ACK, groupAck(1, 8, 6));
    await vi.advanceTimersByTimeAsync(0);
    transport.robotSendsBytes(
      inOneBatch(
        [MessageType.GROUP_ACK, groupAck(1, 8, 6)],
        [MessageType.SAMPLE, sample(1, 0, 100, 1, 1)]
      )
    );

    const epochs = applied(await layout);
    expect(timelines).toEqual([{ id: epoch.timeline + 1, reason: 'clock-reset' }]);
    expect(epochs.map((each) => [each.group, each.timeline])).toEqual([
      [0, epoch.timeline + 1],
      [1, epoch.timeline + 1],
    ]);
    expect(samples.at(-1)).toMatchObject({ epoch: epochs[1].id, timeUs: 100 });
  });

  test('a LOG is placed on the time of the samples, either side of a wrap', async () => {
    const { transport, link } = await withGroup();
    const logs: LogEvent[] = [];
    link.on('log', (event) => logs.push(event));

    transport.robotSends(MessageType.SAMPLE, sample(0, 0, 2 ** 32 - 500, 0, 0));
    transport.robotSends(MessageType.SAMPLE, sample(0, 1, 500, 0, 0));
    transport.robotSends(MessageType.LOG, log('held', 2 ** 32 - 800));
    transport.robotSends(MessageType.LOG, log('fresh', 600));

    expect(logs.map((event) => event.timeUs)).toEqual([2 ** 32 - 800, 2 ** 32 + 600]);
    expect(link.stats.clockResets).toBe(0);
  });
});

describe('epochs', () => {
  test('an enable whose answer is lost is sent again, and without samples the epoch opens on its answer', async () => {
    const { transport, link } = await streaming();
    const opened: Epoch[] = [];
    link.on('epoch', (epoch) => opened.push(epoch));
    const epochs = link.setGroups([{ variableIds: [0, 1], periodTicks: 8 }]);

    transport.robotSends(MessageType.GROUP_ACK, groupAck(0, 8, 6));
    await vi.advanceTimersByTimeAsync(99);
    expect(opened).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    transport.robotSends(MessageType.GROUP_ACK, groupAck(0, 8, 6));
    await vi.advanceTimersByTimeAsync(0);
    transport.answerPings(0);

    expect(applied(await epochs)).toEqual(opened);
    expect(transport.sentOf(MessageType.GROUP_ENABLE)).toHaveLength(2);
  });

  test('the late answer to a request sent again cannot answer the next one', async () => {
    const { transport, link } = await streaming();
    const opened: Epoch[] = [];
    link.on('epoch', (epoch) => opened.push(epoch));
    const epochs = link.setGroups([{ variableIds: [0, 1], periodTicks: 8 }]);

    await vi.advanceTimersByTimeAsync(100);
    expect(transport.sentOf(MessageType.GROUP_DEFINE)).toHaveLength(2);

    transport.robotSends(MessageType.GROUP_ACK, groupAck(0, 8, 6));
    await vi.advanceTimersByTimeAsync(0);
    transport.robotSends(MessageType.GROUP_ACK, groupAck(0, 8, 6));
    await vi.advanceTimersByTimeAsync(0);

    expect(transport.sentOf(MessageType.GROUP_ENABLE)).toEqual([]);
    expect(opened).toEqual([]);

    transport.answerPings(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(transport.sentOf(MessageType.GROUP_ENABLE)).toHaveLength(1);
    expect(opened).toEqual([]);

    transport.robotSends(MessageType.GROUP_ACK, groupAck(0, 8, 6));
    expect(applied(await epochs)).toEqual(opened);
    expect(opened).toHaveLength(1);
  });

  test('the first sample in the same batch as the enable answer is decoded into its epoch', async () => {
    const { transport, link, samples } = await streaming();
    const opened: Epoch[] = [];
    link.on('epoch', (epoch) => opened.push(epoch));
    const epochs = link.setGroups([{ variableIds: [0, 1], periodTicks: 8 }]);

    transport.robotSends(MessageType.GROUP_ACK, groupAck(0, 8, 6));
    await vi.advanceTimersByTimeAsync(0);
    transport.robotSendsBytes(
      inOneBatch(
        [MessageType.GROUP_ACK, groupAck(0, 8, 6)],
        [MessageType.SAMPLE, sample(0, 0, 1000, 2.5, 7)]
      )
    );

    const [epoch] = applied(await epochs);
    expect(opened).toEqual([epoch]);
    expect(samples).toEqual([
      { epoch: epoch.id, seq: 0, timeUs: 1000, values: [2.5, 7], missingBefore: 0 },
    ]);
  });

  test('samples that arrive when the enable answer was lost open the epoch, and the enable is sent again', async () => {
    const { transport, link, samples, errors } = await streaming();
    const opened: Epoch[] = [];
    link.on('epoch', (epoch) => opened.push(epoch));
    const epochs = link.setGroups([{ variableIds: [0, 1], periodTicks: 8 }]);

    transport.robotSends(MessageType.GROUP_ACK, groupAck(0, 8, 6));
    await vi.advanceTimersByTimeAsync(0);
    transport.robotSends(MessageType.SAMPLE, sample(0, 0, 1000, 1, 1));
    transport.robotSends(MessageType.SAMPLE, sample(0, 1, 2000, 1, 1));

    expect(opened).toHaveLength(1);
    expect(samples.map((event) => [event.epoch, event.seq])).toEqual([
      [opened[0].id, 0],
      [opened[0].id, 1],
    ]);

    await vi.advanceTimersByTimeAsync(100);
    transport.robotSends(MessageType.GROUP_ACK, groupAck(0, 8, 6));
    await vi.advanceTimersByTimeAsync(0);
    transport.answerPings(2 * wireSize(13));

    expect(applied(await epochs)).toEqual(opened);
    expect(
      transport.sentOf(MessageType.GROUP_ENABLE).map((frame) => Array.from(frame.payload))
    ).toEqual([
      [0, 1],
      [0, 1],
    ]);
    expect(errors).toEqual([]);
  });

  test('a group whose enable never got an answer is turned off', async () => {
    const { transport, link } = await streaming();
    const epochs = link
      .setGroups([{ variableIds: [0, 1], periodTicks: 8 }])
      .catch((error: unknown) => error);

    transport.robotSends(MessageType.GROUP_ACK, groupAck(0, 8, 6));
    await vi.advanceTimersByTimeAsync(300);
    transport.answerPings(0);
    await vi.advanceTimersByTimeAsync(0);
    transport.robotSends(MessageType.GROUP_ACK, groupAck(0, 8, 6));

    expect(await epochs).toBeInstanceOf(TimeoutError);
    expect(
      transport.sentOf(MessageType.GROUP_ENABLE).map((frame) => Array.from(frame.payload))
    ).toEqual([
      [0, 1],
      [0, 1],
      [0, 1],
      [0, 0],
    ]);
    expect(link.openEpochs).toEqual([]);
  });

  test('samples of a group with no epoch turn it off, and NO_SUCH_GROUP means it is off', async () => {
    const { transport, errors } = await streaming();

    transport.robotSends(MessageType.SAMPLE, sample(2, 0, 0, 0, 0));
    await vi.advanceTimersByTimeAsync(0);
    transport.robotSends(MessageType.ERROR, new PayloadWriter().u8(2).u16(2).done());
    await vi.advanceTimersByTimeAsync(0);

    expect(Array.from(transport.sentOf(MessageType.GROUP_ENABLE)[0].payload)).toEqual([2, 0]);
    expect(errors).toEqual([]);
  });

  test('a gap in the sequence is reported on the sample after it', async () => {
    const { transport, samples } = await withGroup();

    transport.robotSends(MessageType.SAMPLE, sample(0, 0, 0, 0, 0));
    transport.robotSends(MessageType.SAMPLE, sample(0, 3, 3000, 0, 0));

    expect(samples.map((event) => event.missingBefore)).toEqual([0, 2]);
  });

  test('stats and open epochs are the same object until one of them changes', async () => {
    const { transport, link } = await withGroup();
    const stats = link.stats;
    const open = link.openEpochs;

    expect(link.stats).toBe(stats);
    expect(link.openEpochs).toBe(open);

    transport.robotSends(MessageType.SAMPLE, sample(0, 0, 0, 0, 0));

    expect(link.stats).not.toBe(stats);
    expect(link.openEpochs).toBe(open);
  });
});

describe('writes across a reconnection', () => {
  test('a write in flight when the transport drops fails, and never blocks the next one', async () => {
    const { transport, link } = await streaming();
    const inFlight = link.write(0, 1.5).catch((error: unknown) => error);
    const held = link.write(0, 2.5).catch((error: unknown) => error);

    transport.drop();

    expect(await inFlight).toBeInstanceOf(LinkError);
    expect(await held).toBeInstanceOf(LinkError);
    expect(link.pendingWrite(0)).toBeUndefined();

    transport.open();
    transport.robotSends(MessageType.HELLO_ACK, helloAck());
    await vi.advanceTimersByTimeAsync(0);
    const next = link.write(0, 3);
    transport.robotSends(MessageType.WRITE_ACK, new PayloadWriter().u16(0).u8(0).done());

    expect(await next).toEqual({ status: 'answered', writeStatus: 0 });
    expect(transport.sentOf(MessageType.WRITE)).toHaveLength(2);
  });

  test('a newer write replaces one waiting, and the newest value ends up on the robot', async () => {
    const { transport, link } = await streaming();
    const first = link.write(0, 1);
    const replaced = link.write(0, 2);
    const newest = link.write(0, 3);

    expect(await replaced).toEqual({ status: 'superseded' });
    expect(link.pendingWrite(0)).toBe(3);

    transport.robotSends(MessageType.WRITE_ACK, new PayloadWriter().u16(0).u8(0).done());
    await first;
    transport.robotSends(MessageType.WRITE_ACK, new PayloadWriter().u16(0).u8(0).done());
    await newest;

    const values = transport
      .sentOf(MessageType.WRITE)
      .map((frame) =>
        new DataView(frame.payload.buffer, frame.payload.byteOffset).getFloat32(2, true)
      );
    expect(values).toEqual([1, 3]);
  });
});
