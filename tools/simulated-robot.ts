/**
 * A robot that speaks the protocol over a socket, so that the whole application can be developed
 * and debugged before a radio module is plugged into anything.
 *
 * It implements the same session as `micras_comm`: the handshake, a paged schema, coherent groups
 * at whatever period is asked for, the credit window, writes with their acknowledgements, commands
 * and a full rate capture. The signals are made up; everything around them is not.
 *
 * Run with `npm run simulate`, then connect the application to ws://localhost:8080.
 */

import { WebSocketServer, WebSocket } from 'ws';

import { encodeFrame, FrameReader, Reader, Writer } from '../src/lib/comm/Frame';
import {
  MAX_GROUPS,
  MAX_GROUP_VARIABLES,
  MAX_PAYLOAD_SIZE,
  MessageType,
  PROTOCOL_VERSION,
  TraceState,
  TriggerType,
  TypeCode,
  WriteStatus,
} from '../src/lib/comm/Protocol';
import { TYPE_SIZE, writeValue } from '../src/lib/comm/TypeCodec';

const LOOP_TIME_US = 125;
const INITIAL_CREDIT = 256;
const SAMPLE_HEADER_SIZE = 7;
const PORT = Number(process.env.MICRAS_SIM_PORT ?? 8080);

/** One registered variable, the way the firmware's pool holds it. */
interface Variable {
  name: string;
  type: TypeCode;
  access: number;
  value: number | boolean;
  sample?: (t: number) => number;
}

const ACCESS_STREAM = 0x01;
const ACCESS_WRITE = 0x02;
const ACCESS_IDLE = 0x04;
const ACCESS_PERSIST = 0x08;

const variables: Variable[] = [
  {
    name: 'imu/gyro_x',
    type: TypeCode.F32,
    access: ACCESS_STREAM,
    value: 0,
    sample: (t) => Math.sin(t * 3),
  },
  {
    name: 'imu/gyro_y',
    type: TypeCode.F32,
    access: ACCESS_STREAM,
    value: 0,
    sample: (t) => Math.cos(t * 3),
  },
  {
    name: 'imu/gyro_z',
    type: TypeCode.F32,
    access: ACCESS_STREAM,
    value: 0,
    sample: (t) => Math.sin(t * 11) * 0.3,
  },
  {
    name: 'imu/accel_x',
    type: TypeCode.F32,
    access: ACCESS_STREAM,
    value: 0,
    sample: (t) => Math.sin(t) * 2,
  },
  {
    name: 'imu/accel_y',
    type: TypeCode.F32,
    access: ACCESS_STREAM,
    value: 0,
    sample: (t) => Math.cos(t) * 2,
  },
  {
    name: 'imu/accel_z',
    type: TypeCode.F32,
    access: ACCESS_STREAM,
    value: 0,
    sample: () => 9.81,
  },
  {
    name: 'wall/0',
    type: TypeCode.F32,
    access: ACCESS_STREAM,
    value: 0,
    sample: (t) => 0.5 + Math.sin(t * 0.7) * 0.4,
  },
  {
    name: 'wall/1',
    type: TypeCode.F32,
    access: ACCESS_STREAM,
    value: 0,
    sample: (t) => 0.5 + Math.cos(t * 0.7) * 0.4,
  },
  {
    name: 'wall/2',
    type: TypeCode.F32,
    access: ACCESS_STREAM,
    value: 0,
    sample: (t) => 0.5 + Math.sin(t * 1.3) * 0.3,
  },
  {
    name: 'wall/3',
    type: TypeCode.F32,
    access: ACCESS_STREAM,
    value: 0,
    sample: (t) => 0.5 + Math.cos(t * 1.3) * 0.3,
  },
  {
    name: 'loop/elapsed_time',
    type: TypeCode.F32,
    access: ACCESS_STREAM,
    value: 0,
    sample: () => 0.000125,
  },
  {
    name: 'loop/worst_time_us',
    type: TypeCode.U32,
    access: ACCESS_STREAM,
    value: 0,
    sample: () => 91,
  },
  {
    name: 'cmd/linear',
    type: TypeCode.F32,
    access: ACCESS_STREAM,
    value: 0,
    sample: (t) => Math.min(t % 4, 1.5),
  },
  {
    name: 'cmd/angular',
    type: TypeCode.F32,
    access: ACCESS_STREAM,
    value: 0,
    sample: (t) => Math.sin(t * 2) * 4,
  },
  {
    name: 'response/left',
    type: TypeCode.F32,
    access: ACCESS_STREAM,
    value: 0,
    sample: (t) => Math.sin(t * 2 + 0.1) * 30,
  },
  {
    name: 'response/right',
    type: TypeCode.F32,
    access: ACCESS_STREAM,
    value: 0,
    sample: (t) => Math.sin(t * 2 - 0.1) * 30,
  },
  {
    name: 'feed_forward/left',
    type: TypeCode.F32,
    access: ACCESS_STREAM,
    value: 0,
    sample: (t) => Math.min(t % 4, 1.5) * 20,
  },
  {
    name: 'feed_forward/right',
    type: TypeCode.F32,
    access: ACCESS_STREAM,
    value: 0,
    sample: (t) => Math.min(t % 4, 1.5) * 20,
  },
  {
    name: 'objective',
    type: TypeCode.U8,
    access: ACCESS_STREAM | ACCESS_WRITE | ACCESS_IDLE,
    value: 0,
  },
  {
    name: 'run_profile',
    type: TypeCode.U8,
    access: ACCESS_STREAM | ACCESS_WRITE | ACCESS_PERSIST,
    value: 0,
  },
  { name: 'link/dropped_samples', type: TypeCode.U32, access: ACCESS_STREAM, value: 0 },
  { name: 'link/dropped_logs', type: TypeCode.U32, access: ACCESS_STREAM, value: 0 },
  {
    name: 'link/credit',
    type: TypeCode.I32,
    access: ACCESS_STREAM,
    value: INITIAL_CREDIT,
  },
];

/** The same FNV-1a the firmware hashes its schema with, so the hash matches a real robot's. */
function mix(hash: number, bytes: Uint8Array): number {
  let mixed = hash;

  for (const byte of bytes) {
    mixed = Math.imul(mixed ^ byte, 16777619) >>> 0;
  }

  return mixed;
}

function schemaHash(): number {
  let hash = 2166136261;

  for (const variable of variables) {
    hash = mix(hash, new TextEncoder().encode(variable.name));
    hash = mix(hash, new Uint8Array([variable.type, variable.access]));
  }

  return hash;
}

interface Group {
  ids: number[];
  period: number;
  sampleSize: number;
  enabled: boolean;
  counter: number;
  sequence: number;
}

class Robot {
  private reader = new FrameReader();
  private groups: (Group | undefined)[] = new Array(MAX_GROUPS).fill(undefined);
  private credit = INITIAL_CREDIT;
  private schemaIndex = variables.length;
  private iteration = 0;
  private droppedSamples = 0;
  private idle = true;

  private traceState = TraceState.IDLE;
  private traceGroup?: Group;
  private traceRing: number[][] = [];
  private traceCapacity = 2048;
  private tracePre = 0;
  private traceRemaining = 0;
  private traceDumpOffset?: number;
  private traceBytes = new Uint8Array(0);

  constructor(private readonly socket: WebSocket) {
    socket.on('message', (data: Buffer) => this.onData(new Uint8Array(data)));
  }

  /** One control loop iteration. */
  tick(): void {
    this.iteration++;

    this.captureTrace();

    for (let index = 0; index < MAX_GROUPS; index++) {
      const group = this.groups[index];

      if (!group?.enabled) {
        continue;
      }

      if (group.counter > 0) {
        group.counter--;
        continue;
      }

      group.counter = group.period - 1;

      const writer = new Writer()
        .u8(index)
        .u16(group.sequence++ & 0xffff)
        .u32((this.iteration * LOOP_TIME_US) >>> 0)
        .raw(this.sampleGroup(group));

      if (!this.sendMetered(MessageType.SAMPLE, writer.done())) {
        this.droppedSamples++;
        variables[20].value = this.droppedSamples;
      }
    }

    this.dumpTrace();
  }

  private now(): number {
    return (this.iteration * LOOP_TIME_US) / 1e6;
  }

  private sampleGroup(group: Group): Uint8Array {
    const bytes: number[] = [];
    const t = this.now();

    for (const id of group.ids) {
      const variable = variables[id];
      const value = variable.sample ? variable.sample(t) : variable.value;
      bytes.push(...writeValue(value as number, variable.type));
    }

    return new Uint8Array(bytes);
  }

  private onData(data: Uint8Array): void {
    for (const frame of this.reader.push(data)) {
      this.consume(frame.type, frame.payload);
    }
  }

  private consume(type: MessageType, payload: Uint8Array): void {
    const reader = new Reader(payload);

    switch (type) {
      case MessageType.PING:
        this.send(MessageType.PONG, new Uint8Array(0));
        break;

      case MessageType.HELLO:
        this.groups.fill(undefined);
        this.credit = INITIAL_CREDIT;
        this.schemaIndex = variables.length;
        this.traceState = TraceState.IDLE;
        this.traceDumpOffset = undefined;
        this.send(
          MessageType.HELLO_ACK,
          new Writer()
            .u8(PROTOCOL_VERSION)
            .u32(schemaHash())
            .u16(variables.length)
            .u32(LOOP_TIME_US)
            .u16(INITIAL_CREDIT)
            .done()
        );
        break;

      case MessageType.SCHEMA_REQUEST:
        this.schemaIndex = reader.u16();
        break;

      case MessageType.GROUP_DEFINE:
        this.onGroupDefine(reader);
        break;

      case MessageType.GROUP_ENABLE:
        this.onGroupEnable(reader);
        break;

      case MessageType.CREDIT:
        this.credit = Math.min(this.credit + reader.u16(), INITIAL_CREDIT);
        variables[22].value = this.credit;
        break;

      case MessageType.WRITE:
        this.onWrite(reader);
        break;

      case MessageType.READ:
        this.onRead(reader);
        break;

      case MessageType.COMMAND:
        this.onCommand(reader);
        break;

      case MessageType.TRACE_ARM:
        this.onTraceArm(reader);
        break;

      case MessageType.TRACE_READ:
        this.onTraceRead(reader);
        break;

      default:
        console.warn('Unknown message type:', type);
        break;
    }
  }

  private onGroupDefine(reader: Reader): void {
    const index = reader.u8();
    const period = Math.max(1, reader.u16());
    const count = reader.u8();
    const ids: number[] = [];

    for (let i = 0; i < count; i++) {
      ids.push(reader.u16());
    }

    if (
      index >= MAX_GROUPS ||
      count > MAX_GROUP_VARIABLES ||
      ids.some((id) => !variables[id])
    ) {
      this.send(MessageType.ERROR, new Writer().u8(2).u16(index).done());
      return;
    }

    const sampleSize = ids.reduce(
      (total, id) => total + TYPE_SIZE[variables[id].type],
      0
    );

    if (sampleSize + SAMPLE_HEADER_SIZE > MAX_PAYLOAD_SIZE) {
      this.send(MessageType.ERROR, new Writer().u8(3).u16(sampleSize).done());
      return;
    }

    this.groups[index] = {
      ids,
      period,
      sampleSize,
      enabled: false,
      counter: 0,
      sequence: 0,
    };
    this.send(
      MessageType.GROUP_ACK,
      new Writer().u8(index).u16(period).u16(sampleSize).done()
    );
  }

  private onGroupEnable(reader: Reader): void {
    const index = reader.u8();
    const enable = reader.u8() !== 0;
    const group = this.groups[index];

    if (!group) {
      this.send(MessageType.ERROR, new Writer().u8(2).u16(index).done());
      return;
    }

    group.enabled = enable;
    group.counter = 0;
    this.send(
      MessageType.GROUP_ACK,
      new Writer().u8(index).u16(group.period).u16(group.sampleSize).done()
    );
  }

  private onWrite(reader: Reader): void {
    const id = reader.u16();
    const bytes = reader.rest();
    const variable = variables[id];
    let status = WriteStatus.OK;

    if (!variable) {
      status = WriteStatus.NO_SUCH_ID;
    } else if ((variable.access & ACCESS_WRITE) === 0) {
      status = WriteStatus.READ_ONLY;
    } else if ((variable.access & ACCESS_IDLE) !== 0 && !this.idle) {
      status = WriteStatus.NEEDS_IDLE;
    } else if (bytes.length !== TYPE_SIZE[variable.type]) {
      status = WriteStatus.WRONG_SIZE;
    } else {
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      variable.value =
        variable.type === TypeCode.F32 ? view.getFloat32(0, true) : view.getUint8(0);
      console.log(`write ${variable.name} = ${variable.value}`);
    }

    this.send(MessageType.WRITE_ACK, new Writer().u16(id).u8(status).done());
  }

  private onRead(reader: Reader): void {
    const id = reader.u16();
    const variable = variables[id];

    if (!variable) {
      this.send(MessageType.ERROR, new Writer().u8(5).u16(id).done());
      return;
    }

    const value = variable.sample ? variable.sample(this.now()) : variable.value;
    this.send(
      MessageType.VALUE,
      new Writer()
        .u16(id)
        .raw(writeValue(value as number, variable.type))
        .done()
    );
  }

  private onCommand(reader: Reader): void {
    const code = reader.u8();
    const argument = reader.u32();

    console.log(`command ${code} (${argument})`);

    if (code === 5) {
      this.fireTrace();
    }

    this.idle = code !== 0 && code !== 1;
    this.send(MessageType.COMMAND_ACK, new Writer().u8(code).u8(0).done());
    this.send(
      MessageType.LOG,
      new Writer()
        .u8(1)
        .raw(new TextEncoder().encode(`ran command ${code}`))
        .done()
    );
  }

  private onTraceArm(reader: Reader): void {
    const index = reader.u8();
    const preTrigger = reader.u8();
    const trigger = reader.u8() as TriggerType;
    const group = this.groups[index];

    if (!group) {
      this.send(MessageType.ERROR, new Writer().u8(2).u16(index).done());
      return;
    }

    this.traceGroup = group;
    this.traceCapacity = Math.floor(32768 / group.sampleSize);
    this.tracePre = Math.min(
      Math.floor((this.traceCapacity * Math.min(preTrigger, 100)) / 100),
      this.traceCapacity - 1
    );
    this.traceRing = [];
    this.traceState = TraceState.ARMED;
    this.traceDumpOffset = undefined;

    if (trigger === TriggerType.IMMEDIATE) {
      this.fireTrace();
    }

    this.sendTraceStatus();
  }

  private fireTrace(): void {
    if (this.traceState !== TraceState.ARMED) {
      return;
    }

    this.tracePre = Math.min(this.traceRing.length, this.tracePre);
    this.traceRemaining = this.traceCapacity - this.tracePre;
    this.traceState = TraceState.TRIGGERED;
  }

  private captureTrace(): void {
    if (!this.traceGroup) {
      return;
    }

    if (
      this.traceState !== TraceState.ARMED &&
      this.traceState !== TraceState.TRIGGERED
    ) {
      return;
    }

    this.traceRing.push([...this.sampleGroup(this.traceGroup)]);

    while (this.traceRing.length > this.traceCapacity) {
      this.traceRing.shift();
    }

    if (this.traceState === TraceState.TRIGGERED && --this.traceRemaining === 0) {
      this.traceState = TraceState.FULL;
      this.traceBytes = new Uint8Array(this.traceRing.flat());
      this.sendTraceStatus();
    }
  }

  private onTraceRead(reader: Reader): void {
    const offset = reader.u32();

    if (this.traceState !== TraceState.FULL) {
      this.sendTraceStatus();
      return;
    }

    this.traceDumpOffset = offset;
  }

  private dumpTrace(): void {
    if (
      this.traceDumpOffset === undefined ||
      this.traceDumpOffset >= this.traceBytes.length
    ) {
      this.traceDumpOffset = undefined;
      return;
    }

    const block = this.traceBytes.subarray(
      this.traceDumpOffset,
      this.traceDumpOffset + 196
    );
    const payload = new Writer().u32(this.traceDumpOffset).raw(block).done();

    if (this.sendMetered(MessageType.TRACE_DATA, payload)) {
      this.traceDumpOffset += block.length;
    }
  }

  private sendTraceStatus(): void {
    this.send(
      MessageType.TRACE_STATUS,
      new Writer()
        .u8(this.traceState)
        .u32(this.traceState === TraceState.FULL ? this.traceRing.length : 0)
        .u32(this.tracePre)
        .u16(this.traceGroup?.sampleSize ?? 0)
        .u16(this.traceGroup?.period ?? 1)
        .u32((this.iteration * LOOP_TIME_US) >>> 0)
        .done()
    );
  }

  /** The schema is paged, because a kilobyte is half a second of a link this slow. */
  sendSchemaPage(): void {
    if (this.schemaIndex >= variables.length) {
      return;
    }

    const writer = new Writer()
      .u32(schemaHash())
      .u16(this.schemaIndex)
      .u16(variables.length)
      .u8(0);

    const header = writer.done();
    const entries: number[] = [];
    let index = this.schemaIndex;
    let count = 0;

    while (index < variables.length) {
      const name = new TextEncoder().encode(variables[index].name);

      if (header.length + entries.length + name.length + 3 > MAX_PAYLOAD_SIZE) {
        break;
      }

      entries.push(variables[index].type, variables[index].access, name.length, ...name);
      index++;
      count++;
    }

    if (count === 0) {
      this.schemaIndex = variables.length;
      return;
    }

    const payload = new Uint8Array(header.length + entries.length);
    payload.set(header, 0);
    payload.set(entries, header.length);
    payload[8] = count;

    if (this.sendMetered(MessageType.SCHEMA_PAGE, payload)) {
      this.schemaIndex = index;
    }
  }

  /**
   * What the robot sends on its own initiative has to fit in the window the application has
   * opened; what it sends in reply is already bounded by the rate of the requests.
   */
  private sendMetered(type: MessageType, payload: Uint8Array): boolean {
    const frame = encodeFrame(type, payload);

    if (this.credit < frame.length) {
      return false;
    }

    this.credit -= frame.length;
    variables[22].value = this.credit;
    this.socket.send(frame);
    return true;
  }

  private send(type: MessageType, payload: Uint8Array): void {
    this.socket.send(encodeFrame(type, payload));
  }
}

const server = new WebSocketServer({ port: PORT });

// Without this a port already in use is an unhandled event, and anything driving this would
// quietly end up talking to whatever is already listening there
server.on('error', (error) => {
  console.error(`could not listen on ${PORT}:`, error.message);
  process.exit(1);
});

server.on('connection', (socket) => {
  console.log('application connected');

  const robot = new Robot(socket);
  const timer = setInterval(() => {
    // One batch per millisecond stands in for the 8 kHz loop, which is fast enough for the
    // application to see and slow enough for a socket
    for (let i = 0; i < 8; i++) {
      robot.tick();
    }

    robot.sendSchemaPage();
  }, 1);

  socket.on('close', () => {
    console.log('application disconnected');
    clearInterval(timer);
  });
});

console.log(`simulated robot listening on ws://localhost:${PORT}`);
console.log(`${variables.length} variables, schema hash ${schemaHash().toString(16)}`);
