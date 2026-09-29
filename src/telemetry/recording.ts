import type { TypeCode } from '@/protocol';

import { crc32 } from './crc32';
import type { BlockRef, PersistedBlock, PersistedColumn } from './persistence';
import { allocateColumn, bytesPerValue, type ColumnKind, kindOfColumn } from './storage';
import type {
  Boundary,
  BoundaryKind,
  IngestionEvent,
  RecordedEpoch,
  RecordedGap,
  RecordedValue,
  TelemetryValue,
} from './types';

/**
 * Recording format, version 1.
 *
 * A recording is a header followed by records, so that a recorder can append records as they
 * happen. Every number is little endian; a string is a `u32` byte count and UTF-8.
 *
 * ```
 * magic         8 bytes   89 4D 4D 52 45 43 0D 0A  ("\x89MMREC\r\n")
 * header size   u32
 * header        UTF-8 JSON, a RecordingHeader
 * records       repeated until the end:
 *   kind        u8        1 epoch, 2 block, 3 gap, 4 boundary, 5 value, 6 epoch closed;
 *                         unknown kinds are skipped
 *   reserved    3 bytes
 *   size        u32       bytes of the payload
 *   check       u32       CRC-32 of the kind, reserved and size bytes, then the payload
 *   payload
 * ```
 *
 * Payloads:
 *
 * - epoch: `u32` epoch id, `u32` group id, `u32` count, then per variable `u32` id, `u32` type and
 *   the name.
 * - block: `u32` epoch id, `u32` block index, `u32` start sample, `u32` length `n`, `u32` column
 *   count, then per column `u32` variable id, `u8` kind (0 f32, 1 f64) and 3 reserved bytes; then
 *   `n` f64 times, then each column's `n` values.
 * - gap: `u32` epoch id, `u8` kind (0 dropped, 1 not stored), 3 reserved bytes, `u32` index, `u32`
 *   count, `f64` start, `f64` time before, `f64` time after (NaN if unknown).
 * - boundary: `u8` kind (0 reconnect, 1 reboot, 2 schema), 7 reserved bytes, `f64` time.
 * - value: `u32` variable id, the name, `f64` time (NaN if unknown), `u8` tag, then by tag: 0 an
 *   `f64`, 1 a `u8` boolean, 2 a 64 bit integer as a decimal string, 3 a string, 4 `u32` count
 *   and bytes.
 * - epoch closed: `u32` epoch id.
 *
 * The check covers the record's own header, so a damaged size cannot send a reader astray. A
 * record that fails its check is skipped up to the next record that passes one, and reported; with
 * none after it, it is where the recording was cut short. A record that passes its check but does
 * not decode is skipped and reported, unless it is the last one, which is also taken as a cut.
 * Version 1 was never released with the check over the payload alone, so it stays version 1.
 *
 * Records need not come in time order. Blocks written back from an earlier recording come after
 * newer ones, so a reader places each block by its epoch and index. A gap may be written again
 * as it grows, as when the memory cap lets go of more of the stretch before it: a later gap
 * record with the epoch and start of an earlier one replaces it. The header's optional `name` is
 * the name the session had when the file was written or exported.
 *
 * @module
 */

/** The version this module writes and reads. */
export const RECORDING_FORMAT_VERSION = 1;

/** The name in every header, to tell a recording from other JSON. */
export const RECORDING_FORMAT = 'micras-monitor-recording';

const MAGIC = new Uint8Array([0x89, 0x4d, 0x4d, 0x52, 0x45, 0x43, 0x0d, 0x0a]);
const RECORD_HEADER_SIZE = 12;
const RECORD_CHECKED_SIZE = 8;

const RECORD_KIND = {
  epoch: 1,
  block: 2,
  gap: 3,
  boundary: 4,
  value: 5,
  'epoch-closed': 6,
} as const;
const COLUMN_KINDS: readonly ColumnKind[] = ['f32', 'f64'];
const GAP_KINDS: readonly RecordedGap['kind'][] = ['dropped', 'not-stored'];
const BOUNDARY_KINDS: readonly BoundaryKind[] = ['reconnect', 'reboot', 'schema'];
const VALUE_TAG = { number: 0, boolean: 1, bigint: 2, string: 3, bytes: 4 } as const;

/**
 * A variable of the robot's schema, as the recording remembers it.
 */
export interface RecordingVariable {
  /** Its id in the schema. */
  readonly id: number;

  /** Its name. */
  readonly name: string;

  /** Its type. */
  readonly type: TypeCode;

  /** Its access byte, as the schema carries it. */
  readonly access?: number;

  /** The type tag of a blob, as protocol v2 carries it. */
  readonly typeTag?: string;
}

/**
 * The JSON part of a recording.
 */
export interface RecordingHeader {
  /** Always {@link RECORDING_FORMAT}. */
  readonly format: typeof RECORDING_FORMAT;

  /** Always {@link RECORDING_FORMAT_VERSION} for what this module writes. */
  readonly version: typeof RECORDING_FORMAT_VERSION;

  /** When recording started, in milliseconds since the Unix epoch. */
  readonly startedAtMs: number;

  /** Whatever the link knows about the robot: its name, boot id, schema hash. */
  readonly robot: Readonly<Record<string, string | number | boolean | null>>;

  /** The robot's schema when recording started. */
  readonly schema: readonly RecordingVariable[];

  /** The session's name, as the user gave it. */
  readonly name?: string;
}

/**
 * One record of a recording.
 */
export type RecordingRecord =
  | { readonly kind: 'epoch'; readonly epoch: RecordedEpoch }
  | { readonly kind: 'epoch-closed'; readonly epochId: number }
  | { readonly kind: 'block'; readonly block: PersistedBlock }
  | { readonly kind: 'gap'; readonly gap: RecordedGap }
  | { readonly kind: 'boundary'; readonly boundary: Boundary }
  | { readonly kind: 'value'; readonly value: RecordedValue };

/**
 * A record that was skipped because it was damaged.
 */
export interface RecordingDamage {
  /** Where the record starts. */
  readonly offset: number;

  /** What was wrong with it. */
  readonly reason: string;
}

/**
 * A whole recording.
 */
export interface Recording {
  /** The header. */
  readonly header: RecordingHeader;

  /** The records, in the order they were written. */
  readonly records: readonly RecordingRecord[];

  /**
   * Where the last, incomplete record starts, when the recording was cut short, as when the tab
   * closed in the middle of a write. The records before it are whole.
   */
  readonly truncatedAt?: number;

  /** Records skipped in the middle of the recording because they were damaged. */
  readonly damaged?: readonly RecordingDamage[];
}

class ByteWriter {
  private bytes: Uint8Array;
  private view: DataView;
  private offset = 0;

  constructor(size = 64) {
    this.bytes = new Uint8Array(size);
    this.view = new DataView(this.bytes.buffer);
  }

  u8(value: number): this {
    this.reserve(1);
    this.view.setUint8(this.offset, value);
    this.offset += 1;
    return this;
  }

  u32(value: number, what: string): this {
    if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
      throw new RangeError(`${what} must fit an unsigned 32 bit integer, got ${value}`);
    }

    this.reserve(4);
    this.view.setUint32(this.offset, value, true);
    this.offset += 4;
    return this;
  }

  f32(value: number): this {
    this.reserve(4);
    this.view.setFloat32(this.offset, value, true);
    this.offset += 4;
    return this;
  }

  f64(value: number): this {
    this.reserve(8);
    this.view.setFloat64(this.offset, value, true);
    this.offset += 8;
    return this;
  }

  skip(count: number): this {
    this.reserve(count);
    this.offset += count;
    return this;
  }

  raw(bytes: Uint8Array): this {
    this.reserve(bytes.byteLength);
    this.bytes.set(bytes, this.offset);
    this.offset += bytes.byteLength;
    return this;
  }

  text(value: string): this {
    const encoded = new TextEncoder().encode(value);
    return this.u32(encoded.byteLength, 'Text length').raw(encoded);
  }

  done(): Uint8Array {
    return this.bytes.slice(0, this.offset);
  }

  private reserve(count: number): void {
    if (this.offset + count <= this.bytes.byteLength) {
      return;
    }

    const grown = new Uint8Array(Math.max(2 * this.bytes.byteLength, this.offset + count));
    grown.set(this.bytes);
    this.bytes = grown;
    this.view = new DataView(grown.buffer);
  }
}

class ByteReader {
  private readonly view: DataView;
  private offset = 0;

  constructor(private readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  get remaining(): number {
    return this.bytes.byteLength - this.offset;
  }

  u8(): number {
    this.need(1);
    return this.view.getUint8(this.offset++);
  }

  u32(): number {
    this.need(4);
    const value = this.view.getUint32(this.offset, true);
    this.offset += 4;
    return value;
  }

  f32(): number {
    this.need(4);
    const value = this.view.getFloat32(this.offset, true);
    this.offset += 4;
    return value;
  }

  f64(): number {
    this.need(8);
    const value = this.view.getFloat64(this.offset, true);
    this.offset += 8;
    return value;
  }

  skip(count: number): void {
    this.need(count);
    this.offset += count;
  }

  raw(count: number): Uint8Array {
    this.need(count);
    const bytes = this.bytes.slice(this.offset, this.offset + count);
    this.offset += count;
    return bytes;
  }

  text(): string {
    return new TextDecoder('utf-8', { fatal: true }).decode(this.raw(this.u32()));
  }

  end(what: string): void {
    if (this.remaining !== 0) {
      throw new Error(`${what} record has ${this.remaining} bytes left over`);
    }
  }

  private need(count: number): void {
    if (this.offset + count > this.bytes.byteLength) {
      throw new Error(`Record ends ${this.offset + count - this.bytes.byteLength} bytes early`);
    }
  }
}

function codeOf<T>(values: readonly T[], value: T, what: string): number {
  const code = values.indexOf(value);

  if (code < 0) {
    throw new RangeError(`Unknown ${what} ${String(value)}`);
  }

  return code;
}

function kindAt<T>(values: readonly T[], code: number, what: string): T {
  if (code >= values.length) {
    throw new Error(`Unknown ${what} ${code} in recording`);
  }

  return values[code];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRobotInfo(value: unknown): value is RecordingHeader['robot'] {
  return (
    isObject(value) &&
    Object.values(value).every(
      (entry) => entry === null || ['string', 'number', 'boolean'].includes(typeof entry)
    )
  );
}

function isRecordingVariable(value: unknown): value is RecordingVariable {
  return (
    isObject(value) &&
    typeof value.id === 'number' &&
    typeof value.name === 'string' &&
    typeof value.type === 'number' &&
    (value.access === undefined || typeof value.access === 'number') &&
    (value.typeTag === undefined || typeof value.typeTag === 'string')
  );
}

function parseHeader(json: string): RecordingHeader {
  const value: unknown = JSON.parse(json);

  if (!isObject(value) || value.format !== RECORDING_FORMAT) {
    throw new Error('Recording header is not a monitor recording header');
  }

  if (value.version !== RECORDING_FORMAT_VERSION) {
    throw new Error(`Recording format version ${String(value.version)} is not supported`);
  }

  const { startedAtMs, robot, schema, name } = value;

  if (
    typeof startedAtMs !== 'number' ||
    !isRobotInfo(robot) ||
    !Array.isArray(schema) ||
    !schema.every(isRecordingVariable) ||
    (name !== undefined && typeof name !== 'string')
  ) {
    throw new Error('Recording header is malformed');
  }

  return {
    format: RECORDING_FORMAT,
    version: RECORDING_FORMAT_VERSION,
    startedAtMs,
    robot,
    schema,
    ...(name === undefined ? {} : { name }),
  };
}

/**
 * Lay out the samples of a block, as the payload of a block record.
 */
export function encodeBlock(block: PersistedBlock): Uint8Array {
  const length = block.time.length;
  let size = 20 + 8 * block.columns.length + 8 * length;

  for (const column of block.columns) {
    size += column.values.byteLength;
  }

  const writer = new ByteWriter(size)
    .u32(block.ref.epochId, 'Epoch id')
    .u32(block.ref.index, 'Block index')
    .u32(block.startSample, 'Start sample')
    .u32(length, 'Block length')
    .u32(block.columns.length, 'Column count');

  for (const column of block.columns) {
    if (column.values.length !== length) {
      throw new Error(
        `Column ${column.variableId} has ${column.values.length} values, not ${length}`
      );
    }

    writer
      .u32(column.variableId, 'Variable id')
      .u8(codeOf(COLUMN_KINDS, kindOfColumn(column.values), 'column kind'))
      .skip(3);
  }

  for (let index = 0; index < length; index++) {
    writer.f64(block.time[index]);
  }

  for (const column of block.columns) {
    const values = column.values;

    for (let index = 0; index < length; index++) {
      if (values instanceof Float32Array) {
        writer.f32(values[index]);
      } else {
        writer.f64(values[index]);
      }
    }
  }

  return writer.done();
}

/**
 * Where a block record's samples belong and how many it holds, checked against its layout
 * without reading the samples.
 *
 * @throws If the payload is truncated, too long or names an unknown column kind.
 */
export function peekBlock(bytes: Uint8Array): { readonly ref: BlockRef; readonly length: number } {
  const reader = new ByteReader(bytes);
  const ref = { epochId: reader.u32(), index: reader.u32() };
  reader.u32();
  const length = reader.u32();
  checkLayout(reader, bytes.byteLength, length);
  return { ref, length };
}

function checkLayout(
  reader: ByteReader,
  size: number,
  length: number
): { variableId: number; kind: ColumnKind }[] {
  const count = reader.u32();

  if (8 * count > reader.remaining) {
    throw new Error(`Block record of ${size} bytes cannot hold ${count} columns`);
  }

  const layout = Array.from({ length: count }, () => {
    const variableId = reader.u32();
    const kind = kindAt(COLUMN_KINDS, reader.u8(), 'column kind');
    reader.skip(3);
    return { variableId, kind };
  });
  const needed =
    8 * length + layout.reduce((sum, { kind }) => sum + length * bytesPerValue(kind), 0);

  if (needed !== reader.remaining) {
    throw new Error(
      `Block record holds ${reader.remaining} bytes of samples, its layout needs ${needed}`
    );
  }

  return layout;
}

/**
 * Read back the payload of a block record, into arrays of exactly its length.
 *
 * @throws If the payload is truncated, too long or names an unknown column kind.
 */
export function decodeBlock(bytes: Uint8Array): PersistedBlock {
  const reader = new ByteReader(bytes);
  const ref = { epochId: reader.u32(), index: reader.u32() };
  const startSample = reader.u32();
  const length = reader.u32();
  const layout = checkLayout(reader, bytes.byteLength, length);
  const time = new Float64Array(length);

  for (let index = 0; index < length; index++) {
    time[index] = reader.f64();
  }

  const columns: PersistedColumn[] = layout.map(({ variableId, kind }) => {
    const values = allocateColumn(kind, length);

    for (let index = 0; index < length; index++) {
      values[index] = kind === 'f32' ? reader.f32() : reader.f64();
    }

    return { variableId, values };
  });

  return { ref, startSample, time, columns };
}

function encodeValue(writer: ByteWriter, value: TelemetryValue): void {
  if (typeof value === 'number') {
    writer.u8(VALUE_TAG.number).f64(value);
  } else if (typeof value === 'boolean') {
    writer.u8(VALUE_TAG.boolean).u8(value ? 1 : 0);
  } else if (typeof value === 'bigint') {
    writer.u8(VALUE_TAG.bigint).text(value.toString());
  } else if (typeof value === 'string') {
    writer.u8(VALUE_TAG.string).text(value);
  } else {
    writer.u8(VALUE_TAG.bytes).u32(value.byteLength, 'Blob size').raw(value);
  }
}

function decodeValue(reader: ByteReader): TelemetryValue {
  const tag = reader.u8();

  switch (tag) {
    case VALUE_TAG.number:
      return reader.f64();
    case VALUE_TAG.boolean:
      return reader.u8() !== 0;
    case VALUE_TAG.bigint:
      return BigInt(reader.text());
    case VALUE_TAG.string:
      return reader.text();
    case VALUE_TAG.bytes:
      return reader.raw(reader.u32());
    default:
      throw new Error(`Unknown value tag ${tag} in recording`);
  }
}

function payloadOf(record: RecordingRecord): Uint8Array {
  if (record.kind === 'block') {
    return encodeBlock(record.block);
  }

  const writer = new ByteWriter();

  if (record.kind === 'epoch') {
    const { epoch } = record;
    writer
      .u32(epoch.epochId, 'Epoch id')
      .u32(epoch.groupId, 'Group id')
      .u32(epoch.variables.length, 'Variable count');

    for (const variable of epoch.variables) {
      writer.u32(variable.id, 'Variable id').u32(variable.type, 'Type code').text(variable.name);
    }
  } else if (record.kind === 'epoch-closed') {
    writer.u32(record.epochId, 'Epoch id');
  } else if (record.kind === 'gap') {
    const { gap } = record;
    writer
      .u32(gap.epochId, 'Epoch id')
      .u8(codeOf(GAP_KINDS, gap.kind, 'gap kind'))
      .skip(3)
      .u32(gap.index, 'Gap index')
      .u32(gap.count, 'Gap count')
      .f64(gap.startUs)
      .f64(gap.afterUs)
      .f64(gap.untilUs);
  } else if (record.kind === 'boundary') {
    writer
      .u8(codeOf(BOUNDARY_KINDS, record.boundary.kind, 'boundary kind'))
      .skip(7)
      .f64(record.boundary.timeUs);
  } else {
    const { value } = record;
    writer.u32(value.variableId, 'Variable id').text(value.name).f64(value.timeUs);
    encodeValue(writer, value.value);
  }

  return writer.done();
}

function decodeRecord(kind: number, payload: Uint8Array): RecordingRecord | undefined {
  if (kind === RECORD_KIND.block) {
    return { kind: 'block', block: decodeBlock(payload) };
  }

  const reader = new ByteReader(payload);
  let record: RecordingRecord;

  switch (kind) {
    case RECORD_KIND.epoch: {
      const epochId = reader.u32();
      const groupId = reader.u32();
      const count = reader.u32();

      if (12 * count > reader.remaining) {
        throw new Error(`Epoch record cannot hold ${count} variables`);
      }

      const variables = Array.from({ length: count }, () => ({
        id: reader.u32(),
        type: reader.u32() as TypeCode,
        name: reader.text(),
      }));
      record = { kind: 'epoch', epoch: { epochId, groupId, variables } };
      break;
    }
    case RECORD_KIND['epoch-closed']:
      record = { kind: 'epoch-closed', epochId: reader.u32() };
      break;
    case RECORD_KIND.gap: {
      const epochId = reader.u32();
      const gapKind = kindAt(GAP_KINDS, reader.u8(), 'gap kind');
      reader.skip(3);
      record = {
        kind: 'gap',
        gap: {
          epochId,
          kind: gapKind,
          index: reader.u32(),
          count: reader.u32(),
          startUs: reader.f64(),
          afterUs: reader.f64(),
          untilUs: reader.f64(),
        },
      };
      break;
    }
    case RECORD_KIND.boundary: {
      const boundaryKind = kindAt(BOUNDARY_KINDS, reader.u8(), 'boundary kind');
      reader.skip(7);
      record = { kind: 'boundary', boundary: { kind: boundaryKind, timeUs: reader.f64() } };
      break;
    }
    case RECORD_KIND.value: {
      const variableId = reader.u32();
      const name = reader.text();
      const timeUs = reader.f64();
      record = { kind: 'value', value: { variableId, name, timeUs, value: decodeValue(reader) } };
      break;
    }
    default:
      return undefined;
  }

  reader.end(record.kind);
  return record;
}

/**
 * The bytes a recording starts with: the magic, the header size and the header.
 *
 * @throws If the start time is not a finite number, which JSON could not carry.
 */
export function encodeRecordingHeader(header: RecordingHeader): Uint8Array {
  if (!Number.isFinite(header.startedAtMs)) {
    throw new RangeError(`Recording start must be a finite time, got ${header.startedAtMs}`);
  }

  const json = new TextEncoder().encode(JSON.stringify(header));
  return new ByteWriter(MAGIC.length + 4 + json.byteLength)
    .raw(MAGIC)
    .u32(json.byteLength, 'Header size')
    .raw(json)
    .done();
}

/**
 * The bytes of one record, to append after the header.
 */
export function encodeRecordingRecord(record: RecordingRecord): Uint8Array {
  const payload = payloadOf(record);
  const head = new ByteWriter(RECORD_CHECKED_SIZE)
    .u8(RECORD_KIND[record.kind])
    .skip(3)
    .u32(payload.byteLength, 'Record size')
    .done();
  return new ByteWriter(RECORD_HEADER_SIZE + payload.byteLength)
    .raw(head)
    .u32(crc32(payload, crc32(head)), 'Record check')
    .raw(payload)
    .done();
}

/**
 * The record a recorder writes for an ingestion event.
 */
export function recordOf(event: IngestionEvent): RecordingRecord {
  switch (event.type) {
    case 'epoch-opened':
      return { kind: 'epoch', epoch: event.epoch };
    case 'epoch-closed':
      return { kind: 'epoch-closed', epochId: event.epochId };
    case 'gap':
      return { kind: 'gap', gap: event.gap };
    case 'boundary':
      return { kind: 'boundary', boundary: event.boundary };
    default:
      return { kind: 'value', value: event.value };
  }
}

/**
 * Lay out a whole recording.
 */
export function serializeRecording(recording: Recording): Uint8Array {
  const parts = [
    encodeRecordingHeader(recording.header),
    ...recording.records.map((record) => encodeRecordingRecord(record)),
  ];
  const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let offset = 0;

  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }

  return bytes;
}

/**
 * The header of a recording and where the records after it start.
 *
 * @throws If the bytes are not a recording, or its version is not 1.
 */
export function decodeRecordingHeader(bytes: Uint8Array): {
  readonly header: RecordingHeader;
  readonly end: number;
} {
  return decodeHeader(bytes);
}

function decodeHeader(bytes: Uint8Array): { header: RecordingHeader; end: number } {
  if (bytes.byteLength < MAGIC.length + 4 || MAGIC.some((byte, index) => bytes[index] !== byte)) {
    throw new Error('Not a monitor recording');
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const size = view.getUint32(MAGIC.length, true);
  const start = MAGIC.length + 4;

  if (start + size > bytes.byteLength) {
    throw new Error('Recording header is truncated');
  }

  const header = parseHeader(new TextDecoder().decode(bytes.subarray(start, start + size)));
  return { header, end: start + size };
}

function checkedEnd(bytes: Uint8Array, view: DataView, offset: number): number | undefined {
  const stop = recordEnd(bytes, view, offset);

  if (stop === undefined) {
    return undefined;
  }

  const head = crc32(bytes.subarray(offset, offset + RECORD_CHECKED_SIZE));
  const payload = bytes.subarray(offset + RECORD_HEADER_SIZE, stop);
  return crc32(payload, head) === view.getUint32(offset + 8, true) ? stop : undefined;
}

function recordEnd(bytes: Uint8Array, view: DataView, offset: number): number | undefined {
  const start = offset + RECORD_HEADER_SIZE;

  if (start > bytes.byteLength) {
    return undefined;
  }

  const stop = start + view.getUint32(offset + 4, true);
  return stop > bytes.byteLength ? undefined : stop;
}

const KNOWN_KINDS: ReadonlySet<number> = new Set(Object.values(RECORD_KIND));

function plausibleHeader(bytes: Uint8Array, offset: number): boolean {
  return (
    offset + RECORD_HEADER_SIZE <= bytes.byteLength &&
    KNOWN_KINDS.has(bytes[offset]) &&
    bytes[offset + 1] === 0 &&
    bytes[offset + 2] === 0 &&
    bytes[offset + 3] === 0
  );
}

/**
 * The first offset from `from` on where a record passes its check. A candidate followed by the
 * end or by another plausible header is checked as it is met; the others, which are mostly
 * zeros read as headers, only once one ahead passed or none did, and only those before it, so
 * that the result is the earliest record that passes without running a check at every offset.
 */
function nextRecord(bytes: Uint8Array, view: DataView, from: number): number | undefined {
  const deferred: number[] = [];

  for (let offset = from; offset + RECORD_HEADER_SIZE <= bytes.byteLength; offset++) {
    if (!plausibleHeader(bytes, offset)) {
      continue;
    }

    const stop = recordEnd(bytes, view, offset);

    if (stop === undefined) {
      continue;
    }

    if (stop !== bytes.byteLength && !plausibleHeader(bytes, stop)) {
      deferred.push(offset);
      continue;
    }

    if (checkedEnd(bytes, view, offset) !== undefined) {
      return deferred.find((early) => checkedEnd(bytes, view, early) !== undefined) ?? offset;
    }
  }

  return deferred.find((early) => checkedEnd(bytes, view, early) !== undefined);
}

function decoded(kind: number, payload: Uint8Array): string | RecordingRecord | undefined {
  try {
    return decodeRecord(kind, payload);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function validated(kind: number, payload: Uint8Array): string | undefined {
  try {
    if (kind === RECORD_KIND.block) {
      peekBlock(payload);
    } else {
      decodeRecord(kind, payload);
    }

    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/**
 * A record found in the bytes of a recording, not decoded yet.
 */
export interface LocatedRecord {
  /** The record's kind byte; unknown kinds are left out. */
  readonly kind: RecordingRecord['kind'];

  /** Where the record starts. */
  readonly offset: number;

  /** Its payload, a view into the bytes. */
  readonly payload: Uint8Array;
}

/**
 * The records of a recording, as {@link scanRecording} finds them.
 */
export interface RecordingScan {
  /** The header. */
  readonly header: RecordingHeader;

  /** The records that passed their check and decode, in file order. */
  readonly records: readonly LocatedRecord[];

  /** Where the whole records end: the size to cut the file to, to drop a damaged tail. */
  readonly validEnd: number;

  /** {@inheritDoc Recording.truncatedAt} */
  readonly truncatedAt?: number;

  /** {@inheritDoc Recording.damaged} */
  readonly damaged?: readonly RecordingDamage[];
}

const KIND_NAMES = new Map<number, RecordingRecord['kind']>([
  [RECORD_KIND.epoch, 'epoch'],
  [RECORD_KIND.block, 'block'],
  [RECORD_KIND.gap, 'gap'],
  [RECORD_KIND.boundary, 'boundary'],
  [RECORD_KIND.value, 'value'],
  [RECORD_KIND['epoch-closed'], 'epoch-closed'],
]);

/**
 * Find the records of a recording without decoding their samples, for a reader that decodes
 * blocks only when it needs them. Damage is handled as {@link deserializeRecording} does.
 *
 * @throws If the bytes are not a recording, or its version is not 1.
 */
export function scanRecording(bytes: Uint8Array): RecordingScan {
  const { header, end } = decodeHeader(bytes);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const records: LocatedRecord[] = [];
  const damaged: RecordingDamage[] = [];
  let truncatedAt: number | undefined;
  let validEnd = end;

  for (let offset = end; offset < bytes.byteLength;) {
    const stop = checkedEnd(bytes, view, offset);

    if (stop === undefined) {
      const next = nextRecord(bytes, view, offset + 1);

      if (next === undefined) {
        truncatedAt = offset;
        break;
      }

      damaged.push({ offset, reason: 'check mismatch' });
      offset = next;
      continue;
    }

    const code = view.getUint8(offset);
    const payload = bytes.subarray(offset + RECORD_HEADER_SIZE, stop);
    const problem = validated(code, payload);

    if (problem !== undefined) {
      if (stop === bytes.byteLength) {
        truncatedAt = offset;
        break;
      }

      damaged.push({ offset, reason: problem });
    } else {
      const kind = KIND_NAMES.get(code);

      if (kind !== undefined) {
        records.push({ kind, offset, payload });
      }
    }

    offset = stop;
    validEnd = stop;
  }

  return {
    header,
    records,
    validEnd,
    ...(truncatedAt === undefined ? {} : { truncatedAt }),
    ...(damaged.length === 0 ? {} : { damaged }),
  };
}

/**
 * Decode a record {@link scanRecording} found.
 *
 * @throws If it does not decode, which the scan already ruled out.
 */
export function decodeLocated(record: LocatedRecord): RecordingRecord {
  const result = decoded(RECORD_KIND[record.kind], record.payload);

  if (result === undefined || typeof result === 'string') {
    throw new Error(`Record at ${record.offset} does not decode: ${result ?? 'unknown kind'}`);
  }

  return result;
}

/** How many bytes a record's own header takes before its payload. */
export const RECORD_OVERHEAD = RECORD_HEADER_SIZE;

/**
 * Read a whole recording. A recording cut short, or whose last record is damaged, still gives
 * the records before, with {@link Recording.truncatedAt} saying where it ends; a damaged record
 * in the middle is skipped and listed in {@link Recording.damaged}.
 *
 * @throws If the bytes are not a recording, or its version is not 1.
 */
export function deserializeRecording(bytes: Uint8Array): Recording {
  const scan = scanRecording(bytes);
  return {
    header: scan.header,
    records: scan.records.map((record) => decodeLocated(record)),
    ...(scan.truncatedAt === undefined ? {} : { truncatedAt: scan.truncatedAt }),
    ...(scan.damaged === undefined ? {} : { damaged: scan.damaged }),
  };
}
