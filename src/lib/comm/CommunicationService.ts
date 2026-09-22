import { encodeFrame, FrameReader, Reader, Writer } from './Frame';
import {
  Access,
  ErrorCode,
  MAX_GROUPS,
  MAX_GROUP_VARIABLES,
  MAX_PAYLOAD_SIZE,
  MessageType,
  PROTOCOL_VERSION,
  Severity,
  TraceState,
  TriggerType,
  TypeCode,
  WriteStatus,
  decodeAccess,
} from './Protocol';
import { SchemaEntry, SerialVariablePool } from './SerialVariablePool';
import { TYPE_SIZE } from './TypeCodec';
import { ISerialVariable } from './variables/ISerialVariable';

export type SendDataFunction = (data: Uint8Array) => Promise<void>;
export type GetDataFunction = () => Promise<Uint8Array>;

/**
 * Number of bytes a sample carries before its values: the group, the sequence number and the
 * timestamp the robot captured them at.
 */
const SAMPLE_HEADER_SIZE = 7;

/**
 * Where the schema of a build is kept, so that it is fetched once per firmware rather than once
 * per connection. It is a kilobyte over a link that carries a few thousand bytes a second.
 */
const SCHEMA_CACHE_KEY = 'micras.schema';

/**
 * What the capture is doing, as the robot last reported it.
 */
export interface TraceStatus {
  state: TraceState;
  samples: number;
  preTrigger: number;
  sampleSize: number;
  period: number;
  timestampUs: number;
}

/**
 * The session with the robot: the handshake, the schema, the groups that stream, the credit window
 * that keeps the radio module from being overrun, and everything that is asked for and answered.
 */
export class CommunicationService {
  private pool: SerialVariablePool;
  private sendDataFunc?: SendDataFunction;
  private getDataFunc?: GetDataFunction;
  private functionsRegistered = false;
  private reader = new FrameReader();
  private isConnected = false;
  private receiveDataTask?: number;
  private verifyConnectionTask?: number;
  private onConnectionStatusChange?: (status: boolean) => void;
  private pongReceived = false;
  private connectionCheckTimeouts: number[] = [];

  private loopTimeUs = 125;
  private schemaHash = 0;
  private variableCount = 0;
  private schemaEntries: SchemaEntry[] = [];
  private schemaRequested = false;

  private groups: number[][] = [];
  private definedGroups = new Set<number>();
  private sampleRateHz = 100;

  private unconsumedBytes = 0;
  private lastTimestampUs = 0;
  private timestampWrapMs = 0;

  private traceStatus?: TraceStatus;
  private traceBlocks: Uint8Array[] = [];
  private onTrace?: (status: TraceStatus, samples: Float64Array[]) => void;

  /**
   * @param pool The variables the session fills.
   * @param onConnectionStatusChange Called when the robot starts or stops answering.
   */
  constructor(
    pool: SerialVariablePool,
    onConnectionStatusChange?: (status: boolean) => void
  ) {
    this.pool = pool;
    this.onConnectionStatusChange = onConnectionStatusChange;

    this.pool.addVariableWriteListener((id, variable) => {
      this.writeVariable(id, variable);
    });
  }

  registerCommunicationFunctions(
    sendFunc: SendDataFunction,
    getFunc: GetDataFunction
  ): void {
    this.sendDataFunc = sendFunc;
    this.getDataFunc = getFunc;
    this.functionsRegistered = true;
  }

  /**
   * Start talking to the robot.
   *
   * @param interval How often the transport is drained, in milliseconds.
   */
  startCommunication(interval: number = 50): void {
    this.stopCommunication();

    this.reader.clear();
    this.receiveDataTask = window.setInterval(() => {
      void this.update();
    }, interval);

    this.hello();
    this.startConnectionVerification();
  }

  stopCommunication(): void {
    this.setConnectionStatus(false);
    this.reader.clear();
    this.groups = [];
    this.definedGroups.clear();
    this.schemaRequested = false;
    this.unconsumedBytes = 0;

    if (this.receiveDataTask !== undefined) {
      clearInterval(this.receiveDataTask);
      this.receiveDataTask = undefined;
    }

    this.stopConnectionVerification();
  }

  isServiceConnected(): boolean {
    return this.isConnected;
  }

  /**
   * The period of the control loop, which is the unit of a group period.
   */
  getLoopTimeUs(): number {
    return this.loopTimeUs;
  }

  /**
   * Set how often the streamed variables are sampled.
   *
   * The link carries a few thousand bytes a second, so eight signals fit in fifty to a hundred
   * samples a second and no more. The control loop runs at eight thousand; to see that, arm a
   * trace instead.
   *
   * @param hz Samples per second.
   */
  setSampleRate(hz: number): void {
    this.sampleRateHz = Math.max(1, hz);
    this.defineGroups();
  }

  getSampleRate(): number {
    return this.sampleRateHz;
  }

  /**
   * Choose which variables are streamed.
   *
   * @param ids The variables to stream, which have to be streamable in the schema.
   */
  setStreamedVariables(ids: number[]): void {
    const streamable = ids.filter((id) => this.pool.getVariable(id)?.getAccess().stream);

    this.groups = [];

    for (const id of streamable) {
      const current = this.groups[this.groups.length - 1];
      const size = TYPE_SIZE[this.pool.getVariable(id)!.getTypeCode()];
      const currentSize = current
        ? current.reduce(
            (total, each) =>
              total + TYPE_SIZE[this.pool.getVariable(each)!.getTypeCode()],
            0
          )
        : 0;

      if (
        !current ||
        current.length >= MAX_GROUP_VARIABLES ||
        currentSize + size + SAMPLE_HEADER_SIZE > MAX_PAYLOAD_SIZE
      ) {
        if (this.groups.length >= MAX_GROUPS) {
          console.warn(`Only ${MAX_GROUPS} groups fit; the rest will not be streamed`);
          break;
        }

        this.groups.push([id]);
      } else {
        current.push(id);
      }
    }

    this.defineGroups();
  }

  getStreamedVariables(): number[] {
    return this.groups.flat();
  }

  /**
   * Add or remove one variable from what is streamed.
   */
  setVariableEnabled(id: number, enabled: boolean): void {
    const current = new Set(this.getStreamedVariables());

    if (enabled) {
      current.add(id);
    } else {
      current.delete(id);
    }

    this.setStreamedVariables([...current]);
  }

  /**
   * Ask the robot to do something once.
   *
   * @param code The command, as the firmware numbers them.
   * @param argument Whatever the command takes.
   */
  sendCommand(code: number, argument: number = 0): void {
    this.send(MessageType.COMMAND, new Writer().u8(code).u32(argument).done());
  }

  /**
   * Ask for the current value of a variable, outside of any stream.
   */
  readVariable(id: number): void {
    this.send(MessageType.READ, new Writer().u16(id).done());
  }

  /**
   * Record a group at the full control loop rate, to be read out once it has stopped.
   *
   * @param group Which of the defined groups to capture.
   * @param preTrigger How much of the capture to keep from before the trigger, in percent.
   * @param trigger What starts it.
   * @param watched The variable a threshold trigger watches.
   * @param threshold The value it has to cross.
   */
  armTrace(
    group: number,
    preTrigger: number,
    trigger: TriggerType,
    watched: number = 0,
    threshold: number = 0
  ): void {
    this.traceBlocks = [];
    this.send(
      MessageType.TRACE_ARM,
      new Writer().u8(group).u8(preTrigger).u8(trigger).u16(watched).f32(threshold).done()
    );
  }

  /**
   * Start reading a finished capture out. It arrives one block per control loop iteration that the
   * credit window allows, and the callback runs once the last block has landed.
   */
  readTrace(onTrace: (status: TraceStatus, samples: Float64Array[]) => void): void {
    this.onTrace = onTrace;
    this.traceBlocks = [];
    this.send(MessageType.TRACE_READ, new Writer().u32(0).done());
  }

  getTraceStatus(): TraceStatus | undefined {
    return this.traceStatus;
  }

  private hello(): void {
    this.schemaRequested = false;
    this.groups = [];
    this.definedGroups.clear();
    this.send(MessageType.HELLO, new Uint8Array(0));
  }

  private async update(): Promise<void> {
    if (!this.functionsRegistered || !this.getDataFunc) {
      return;
    }

    try {
      const data = await this.getDataFunc();

      if (data.length > 0) {
        this.unconsumedBytes += data.length;

        for (const frame of this.reader.push(data)) {
          this.consume(frame.type, frame.payload);
        }
      }
    } catch (error) {
      console.error('Error reading from the transport:', error);
    }

    this.returnCredit();
  }

  /**
   * Tell the robot how much has been taken off the wire. It may not have more than a window of
   * bytes outstanding, because the radio module has no flow control and drops silently when its
   * own buffer fills.
   */
  private returnCredit(): void {
    if (this.unconsumedBytes === 0 || !this.isConnected) {
      return;
    }

    const bytes = Math.min(this.unconsumedBytes, 0xffff);
    this.unconsumedBytes -= bytes;
    this.send(MessageType.CREDIT, new Writer().u16(bytes).done());
  }

  private startConnectionVerification(interval: number = 2000): void {
    this.stopConnectionVerification();

    this.verifyConnectionTask = window.setInterval(() => {
      this.pongReceived = false;
      this.send(MessageType.PING, new Uint8Array(0));

      const timeoutId = window.setTimeout(() => {
        if (this.isConnected && !this.pongReceived) {
          this.setConnectionStatus(false);
        } else if (!this.isConnected && this.pongReceived) {
          this.hello();
        }

        this.clearConnectionCheckTimeout(timeoutId);
      }, 1000);

      this.connectionCheckTimeouts.push(timeoutId);
    }, interval);
  }

  private clearConnectionCheckTimeout(timeoutId: number): void {
    const index = this.connectionCheckTimeouts.indexOf(timeoutId);

    if (index !== -1) {
      this.connectionCheckTimeouts.splice(index, 1);
    }
  }

  private stopConnectionVerification(): void {
    if (this.verifyConnectionTask !== undefined) {
      clearInterval(this.verifyConnectionTask);
      this.verifyConnectionTask = undefined;
    }

    this.connectionCheckTimeouts.forEach((timeoutId) => clearTimeout(timeoutId));
    this.connectionCheckTimeouts = [];
  }

  private setConnectionStatus(status: boolean): void {
    if (this.isConnected !== status) {
      this.isConnected = status;
      this.onConnectionStatusChange?.(status);
    }
  }

  private writeVariable(id: number, variable: ISerialVariable): void {
    if (variable.isReadOnly()) {
      return;
    }

    const payload = variable.serialize();
    this.send(MessageType.WRITE, new Writer().u16(id).raw(payload).done());
  }

  private async send(type: MessageType, payload: Uint8Array): Promise<void> {
    if (!this.sendDataFunc) {
      return;
    }

    try {
      await this.sendDataFunc(encodeFrame(type, payload));
    } catch (error) {
      console.error('Error sending frame:', error);
    }
  }

  private consume(type: MessageType, payload: Uint8Array): void {
    const reader = new Reader(payload);

    switch (type) {
      case MessageType.PONG:
        this.pongReceived = true;
        break;

      case MessageType.HELLO_ACK:
        this.onHelloAck(reader);
        break;

      case MessageType.SCHEMA_PAGE:
        this.onSchemaPage(reader);
        break;

      case MessageType.GROUP_ACK:
        break;

      case MessageType.SAMPLE:
        this.onSample(reader, payload);
        break;

      case MessageType.VALUE:
        this.pool.applyValue(reader.u16(), reader.rest(), this.now());
        break;

      case MessageType.WRITE_ACK:
        this.onWriteAck(reader);
        break;

      case MessageType.COMMAND_ACK:
        this.onCommandAck(reader);
        break;

      case MessageType.LOG:
        this.onLog(reader, payload);
        break;

      case MessageType.TRACE_STATUS:
        this.onTraceStatus(reader);
        break;

      case MessageType.TRACE_DATA:
        this.onTraceData(reader);
        break;

      case MessageType.ERROR:
        console.error(
          `Robot refused a message: ${ErrorCode[reader.u8()]} (${reader.u16()})`
        );
        break;

      default:
        console.warn('Unknown message type:', type);
        break;
    }
  }

  private onHelloAck(reader: Reader): void {
    const version = reader.u8();

    if (version !== PROTOCOL_VERSION) {
      console.error(
        `Robot speaks protocol ${version}, this application speaks ${PROTOCOL_VERSION}`
      );
      this.setConnectionStatus(false);
      return;
    }

    this.schemaHash = reader.u32();
    this.variableCount = reader.u16();
    this.loopTimeUs = reader.u32();
    this.unconsumedBytes = 0;
    reader.u16();

    this.pongReceived = true;
    this.setConnectionStatus(true);

    const cached = this.loadCachedSchema(this.schemaHash);

    if (cached) {
      this.pool.setSchema(this.schemaHash, cached);
      this.schemaRequested = false;
      this.streamEverythingStreamable();
      return;
    }

    this.schemaEntries = [];
    this.schemaRequested = true;
    this.send(MessageType.SCHEMA_REQUEST, new Writer().u16(0).done());
  }

  private onSchemaPage(reader: Reader): void {
    const hash = reader.u32();
    const first = reader.u16();
    const total = reader.u16();
    const count = reader.u8();

    if (!this.schemaRequested || hash !== this.schemaHash) {
      return;
    }

    for (let i = 0; i < count; i++) {
      const type = reader.u8() as TypeCode;
      const access: Access = decodeAccess(reader.u8());
      const name = reader.text(reader.u8());
      this.schemaEntries[first + i] = { id: first + i, type, access, name };
    }

    if (this.schemaEntries.filter(Boolean).length < total) {
      return;
    }

    this.schemaRequested = false;
    this.pool.setSchema(hash, this.schemaEntries);
    this.storeCachedSchema(hash, this.schemaEntries);
    this.streamEverythingStreamable();
  }

  private streamEverythingStreamable(): void {
    const ids: number[] = [];

    this.pool.forEach((variable, id) => {
      if (variable.getAccess().stream) {
        ids.push(id);
      }
    });

    this.setStreamedVariables(ids.slice(0, MAX_GROUPS * MAX_GROUP_VARIABLES));
  }

  private defineGroups(): void {
    if (!this.isConnected) {
      return;
    }

    const period = Math.max(1, Math.round(1e6 / (this.sampleRateHz * this.loopTimeUs)));

    for (let index = 0; index < MAX_GROUPS; index++) {
      const ids = this.groups[index];

      if (!ids || ids.length === 0) {
        if (this.definedGroups.has(index)) {
          this.send(MessageType.GROUP_ENABLE, new Writer().u8(index).u8(0).done());
        }

        continue;
      }

      const writer = new Writer().u8(index).u16(period).u8(ids.length);
      ids.forEach((id) => writer.u16(id));

      this.definedGroups.add(index);
      this.send(MessageType.GROUP_DEFINE, writer.done());
      this.send(MessageType.GROUP_ENABLE, new Writer().u8(index).u8(1).done());
    }
  }

  private onSample(reader: Reader, payload: Uint8Array): void {
    const index = reader.u8();
    reader.u16();
    const timestampUs = reader.u32();
    const ids = this.groups[index];

    if (!ids) {
      return;
    }

    this.pool.applySample(
      ids,
      this.toMilliseconds(timestampUs),
      payload.subarray(SAMPLE_HEADER_SIZE)
    );
  }

  private onWriteAck(reader: Reader): void {
    const id = reader.u16();
    const status = reader.u8() as WriteStatus;

    if (status !== WriteStatus.OK) {
      console.warn(
        `Write to ${this.pool.getVariable(id)?.getName() ?? id} refused: ${WriteStatus[status]}`
      );
    }
  }

  private onCommandAck(reader: Reader): void {
    const code = reader.u8();
    const result = reader.u8();

    if (result !== 0) {
      console.warn(`Command ${code} was not run (${result})`);
    }
  }

  private onLog(reader: Reader, payload: Uint8Array): void {
    const severity = reader.u8() as Severity;
    const text = new TextDecoder().decode(payload.subarray(1));

    if (severity >= Severity.ERROR) {
      console.error('Robot:', text);
    } else if (severity === Severity.WARNING) {
      console.warn('Robot:', text);
    } else {
      console.log('Robot:', text);
    }
  }

  private onTraceStatus(reader: Reader): void {
    this.traceStatus = {
      state: reader.u8() as TraceState,
      samples: reader.u32(),
      preTrigger: reader.u32(),
      sampleSize: reader.u16(),
      period: reader.u16(),
      timestampUs: reader.u32(),
    };
  }

  private onTraceData(reader: Reader): void {
    reader.u32();
    this.traceBlocks.push(reader.rest());

    const held = this.traceBlocks.reduce((total, block) => total + block.length, 0);
    const expected =
      (this.traceStatus?.samples ?? 0) * (this.traceStatus?.sampleSize ?? 0);

    if (held < expected || expected === 0 || !this.onTrace || !this.traceStatus) {
      return;
    }

    const capture = new Uint8Array(held);
    let offset = 0;

    for (const block of this.traceBlocks) {
      capture.set(block, offset);
      offset += block.length;
    }

    const callback = this.onTrace;
    this.onTrace = undefined;
    callback(this.traceStatus, this.splitTrace(capture));
  }

  /**
   * Turn the capture into one series per variable of the group it was armed on.
   */
  private splitTrace(capture: Uint8Array): Float64Array[] {
    const status = this.traceStatus!;
    const ids = this.groups.find(
      (group) =>
        group.reduce(
          (total, id) => total + TYPE_SIZE[this.pool.getVariable(id)!.getTypeCode()],
          0
        ) === status.sampleSize
    );

    if (!ids) {
      return [];
    }

    const series = ids.map(() => new Float64Array(status.samples));
    const view = new DataView(capture.buffer, capture.byteOffset, capture.byteLength);

    for (let sample = 0; sample < status.samples; sample++) {
      let offset = sample * status.sampleSize;

      ids.forEach((id, column) => {
        const type = this.pool.getVariable(id)!.getTypeCode();
        series[column][sample] =
          type === TypeCode.F32
            ? view.getFloat32(offset, true)
            : view.getInt32(offset, true);
        offset += TYPE_SIZE[type];
      });
    }

    return series;
  }

  /**
   * The robot counts microseconds in a 32 bit register, which comes back to zero every 71 minutes.
   */
  private toMilliseconds(timestampUs: number): number {
    if (timestampUs < this.lastTimestampUs) {
      this.timestampWrapMs += 0x100000000 / 1000;
    }

    this.lastTimestampUs = timestampUs;
    return this.timestampWrapMs + timestampUs / 1000;
  }

  private now(): number {
    return this.timestampWrapMs + this.lastTimestampUs / 1000;
  }

  private loadCachedSchema(hash: number): SchemaEntry[] | null {
    try {
      const raw = window.localStorage.getItem(`${SCHEMA_CACHE_KEY}.${hash}`);
      const entries = raw ? (JSON.parse(raw) as SchemaEntry[]) : null;
      return entries && entries.length === this.variableCount ? entries : null;
    } catch {
      return null;
    }
  }

  private storeCachedSchema(hash: number, entries: SchemaEntry[]): void {
    try {
      window.localStorage.setItem(`${SCHEMA_CACHE_KEY}.${hash}`, JSON.stringify(entries));
    } catch {
      console.warn('Could not cache the schema; it will be fetched again next time');
    }
  }
}
