import type { TypeCode } from '@/protocol';

import type { PersistedBlock, PersistedColumn } from './persistence';
import { allocateColumn, bytesPerValue, type ColumnKind, kindOfColumn } from './storage';
import type { Boundary, BoundaryKind, EpochSpec } from './types';

/**
 * Recording format, version 1.
 *
 * A recording is a header followed by records, so that a recorder can append records as they
 * happen. Every number is little endian.
 *
 * ```
 * magic         8 bytes   89 4D 4D 52 45 43 0D 0A  ("\x89MMREC\r\n")
 * header size   u32
 * header        UTF-8 JSON, a RecordingHeader
 * records       repeated until the end:
 *   kind        u8        1 epoch, 2 block, 3 gap, 4 boundary; unknown kinds are skipped
 *   reserved    3 bytes
 *   size        u32       bytes of the payload
 *   payload
 * ```
 *
 * Payloads:
 *
 * - epoch: `u32` epoch id, `u32` group id, `u32` count, then per variable `u32` id and `u32` type.
 * - block: `u32` epoch id, `u32` block index, `u32` start sample, `u32` length `n`, `u32` column
 *   count, then per column `u32` variable id, `u8` kind (0 f32, 1 f64) and 3 reserved bytes; then
 *   `n` f64 times, then each column's `n` values.
 * - gap: `u32` epoch id, `u8` kind (0 dropped, 1 not stored), 3 reserved bytes, `u32` index, `u32`
 *   count, `f64` time before, `f64` time after (NaN if unknown).
 * - boundary: `u8` kind (0 reconnect, 1 reboot), 7 reserved bytes, `f64` time.
 *
 * @module
 */

/** The version this module writes and reads. */
export const RECORDING_FORMAT_VERSION = 1;

/** The name in every header, to tell a recording from other JSON. */
export const RECORDING_FORMAT = 'micras-monitor-recording';

const MAGIC = new Uint8Array([0x89, 0x4d, 0x4d, 0x52, 0x45, 0x43, 0x0d, 0x0a]);
const RECORD_HEADER_SIZE = 8;

const RECORD_KIND = { epoch: 1, block: 2, gap: 3, boundary: 4 } as const;
const COLUMN_KINDS: readonly ColumnKind[] = ['f32', 'f64'];
const GAP_KINDS: readonly RecordedGap['kind'][] = ['dropped', 'not-stored'];
const BOUNDARY_KINDS: readonly BoundaryKind[] = ['reconnect', 'reboot'];

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

  /** The robot's schema. */
  readonly schema: readonly RecordingVariable[];
}

/**
 * Samples missing inside an epoch, as recorded.
 */
export interface RecordedGap {
  /** The epoch. */
  readonly epochId: number;

  /** Whether the samples never arrived or were not kept. */
  readonly kind: 'dropped' | 'not-stored';

  /** The epoch sample index of the first stored sample after the gap. */
  readonly index: number;

  /** How many samples are missing. */
  readonly count: number;

  /** The time of the last sample before the gap, or NaN. */
  readonly afterUs: number;

  /** The time of the first sample after the gap, or NaN. */
  readonly untilUs: number;
}

/**
 * One record of a recording.
 */
export type RecordingRecord =
  | { readonly kind: 'epoch'; readonly epoch: EpochSpec }
  | { readonly kind: 'block'; readonly block: PersistedBlock }
  | { readonly kind: 'gap'; readonly gap: RecordedGap }
  | { readonly kind: 'boundary'; readonly boundary: Boundary };

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
}

function checkU32(value: number, what: string): number {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw new RangeError(`${what} must fit an unsigned 32 bit integer, got ${value}`);
  }

  return value;
}

function codeOf<T>(values: readonly T[], value: T): number {
  return values.indexOf(value);
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
    (value.access === undefined || typeof value.access === 'number')
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

  const { startedAtMs, robot, schema } = value;

  if (
    typeof startedAtMs !== 'number' ||
    !isRobotInfo(robot) ||
    !Array.isArray(schema) ||
    !schema.every(isRecordingVariable)
  ) {
    throw new Error('Recording header is malformed');
  }

  return {
    format: RECORDING_FORMAT,
    version: RECORDING_FORMAT_VERSION,
    startedAtMs,
    robot,
    schema,
  };
}

function blockPayloadSize(block: PersistedBlock): number {
  let size = 20 + 8 * block.columns.length + 8 * block.time.length;

  for (const column of block.columns) {
    size += column.values.byteLength;
  }

  return size;
}

/**
 * Lay out the samples of a block, as the payload of a block record.
 */
export function encodeBlock(block: PersistedBlock): Uint8Array {
  const length = block.time.length;
  const bytes = new Uint8Array(blockPayloadSize(block));
  const view = new DataView(bytes.buffer);
  view.setUint32(0, checkU32(block.ref.epochId, 'Epoch id'), true);
  view.setUint32(4, checkU32(block.ref.index, 'Block index'), true);
  view.setUint32(8, checkU32(block.startSample, 'Start sample'), true);
  view.setUint32(12, length, true);
  view.setUint32(16, block.columns.length, true);
  let offset = 20;

  for (const column of block.columns) {
    if (column.values.length !== length) {
      throw new Error(
        `Column ${column.variableId} has ${column.values.length} values, not ${length}`
      );
    }

    view.setUint32(offset, checkU32(column.variableId, 'Variable id'), true);
    view.setUint8(offset + 4, codeOf(COLUMN_KINDS, kindOfColumn(column.values)));
    offset += 8;
  }

  for (let index = 0; index < length; index++, offset += 8) {
    view.setFloat64(offset, block.time[index], true);
  }

  for (const column of block.columns) {
    const values = column.values;

    if (values instanceof Float32Array) {
      for (let index = 0; index < length; index++, offset += 4) {
        view.setFloat32(offset, values[index], true);
      }
    } else {
      for (let index = 0; index < length; index++, offset += 8) {
        view.setFloat64(offset, values[index], true);
      }
    }
  }

  return bytes;
}

/**
 * Read back the payload of a block record.
 *
 * @throws If the payload is truncated or names an unknown column kind.
 */
export function decodeBlock(bytes: Uint8Array): PersistedBlock {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  if (bytes.byteLength < 20 || 20 + 8 * view.getUint32(16, true) > bytes.byteLength) {
    throw new Error(`Block record of ${bytes.byteLength} bytes is too short for its layout`);
  }

  const length = view.getUint32(12, true);
  const count = view.getUint32(16, true);
  const layout: { variableId: number; kind: ColumnKind }[] = [];
  let offset = 20;

  for (let column = 0; column < count; column++, offset += 8) {
    layout.push({
      variableId: view.getUint32(offset, true),
      kind: kindAt(COLUMN_KINDS, view.getUint8(offset + 4), 'column kind'),
    });
  }

  const expected =
    offset + 8 * length + layout.reduce((sum, { kind }) => sum + length * bytesPerValue(kind), 0);

  if (expected !== bytes.byteLength) {
    throw new Error(`Block record holds ${bytes.byteLength} bytes, its layout needs ${expected}`);
  }

  const time = new Float64Array(length);

  for (let index = 0; index < length; index++, offset += 8) {
    time[index] = view.getFloat64(offset, true);
  }

  const columns: PersistedColumn[] = layout.map(({ variableId, kind }) => {
    const values = allocateColumn(kind, length);
    const size = bytesPerValue(kind);

    for (let index = 0; index < length; index++, offset += size) {
      values[index] =
        kind === 'f32' ? view.getFloat32(offset, true) : view.getFloat64(offset, true);
    }

    return { variableId, values };
  });

  return {
    ref: { epochId: view.getUint32(0, true), index: view.getUint32(4, true) },
    startSample: view.getUint32(8, true),
    time,
    columns,
  };
}

function encodeEpoch(epoch: EpochSpec): Uint8Array {
  const bytes = new Uint8Array(12 + 8 * epoch.variables.length);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, checkU32(epoch.epochId, 'Epoch id'), true);
  view.setUint32(4, checkU32(epoch.groupId, 'Group id'), true);
  view.setUint32(8, epoch.variables.length, true);

  epoch.variables.forEach((variable, index) => {
    view.setUint32(12 + 8 * index, checkU32(variable.id, 'Variable id'), true);
    view.setUint32(16 + 8 * index, checkU32(variable.type, 'Type code'), true);
  });

  return bytes;
}

function decodeEpoch(view: DataView): EpochSpec {
  const count = view.getUint32(8, true);

  if (view.byteLength !== 12 + 8 * count) {
    throw new Error(`Epoch record holds ${view.byteLength} bytes for ${count} variables`);
  }

  return {
    epochId: view.getUint32(0, true),
    groupId: view.getUint32(4, true),
    variables: Array.from({ length: count }, (_, index) => ({
      id: view.getUint32(12 + 8 * index, true),
      type: view.getUint32(16 + 8 * index, true) as TypeCode,
    })),
  };
}

function encodeGap(gap: RecordedGap): Uint8Array {
  const bytes = new Uint8Array(32);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, checkU32(gap.epochId, 'Epoch id'), true);
  view.setUint8(4, codeOf(GAP_KINDS, gap.kind));
  view.setUint32(8, checkU32(gap.index, 'Gap index'), true);
  view.setUint32(12, checkU32(gap.count, 'Gap count'), true);
  view.setFloat64(16, gap.afterUs, true);
  view.setFloat64(24, gap.untilUs, true);
  return bytes;
}

function decodeGap(view: DataView): RecordedGap {
  if (view.byteLength !== 32) {
    throw new Error(`Gap record holds ${view.byteLength} bytes, not 32`);
  }

  return {
    epochId: view.getUint32(0, true),
    kind: kindAt(GAP_KINDS, view.getUint8(4), 'gap kind'),
    index: view.getUint32(8, true),
    count: view.getUint32(12, true),
    afterUs: view.getFloat64(16, true),
    untilUs: view.getFloat64(24, true),
  };
}

function encodeBoundary(boundary: Boundary): Uint8Array {
  const bytes = new Uint8Array(16);
  const view = new DataView(bytes.buffer);
  view.setUint8(0, codeOf(BOUNDARY_KINDS, boundary.kind));
  view.setFloat64(8, boundary.timeUs, true);
  return bytes;
}

function decodeBoundary(view: DataView): Boundary {
  if (view.byteLength !== 16) {
    throw new Error(`Boundary record holds ${view.byteLength} bytes, not 16`);
  }

  return {
    kind: kindAt(BOUNDARY_KINDS, view.getUint8(0), 'boundary kind'),
    timeUs: view.getFloat64(8, true),
  };
}

function payloadOf(record: RecordingRecord): Uint8Array {
  if (record.kind === 'epoch') {
    return encodeEpoch(record.epoch);
  }

  if (record.kind === 'block') {
    return encodeBlock(record.block);
  }

  if (record.kind === 'gap') {
    return encodeGap(record.gap);
  }

  return encodeBoundary(record.boundary);
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let offset = 0;

  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }

  return bytes;
}

/**
 * The bytes a recording starts with: the magic, the header size and the header.
 */
export function encodeRecordingHeader(header: RecordingHeader): Uint8Array {
  if (!Number.isFinite(header.startedAtMs)) {
    throw new RangeError(`Recording start must be a finite time, got ${header.startedAtMs}`);
  }

  const json = new TextEncoder().encode(JSON.stringify(header));
  const bytes = new Uint8Array(MAGIC.length + 4 + json.byteLength);
  bytes.set(MAGIC, 0);
  new DataView(bytes.buffer).setUint32(MAGIC.length, json.byteLength, true);
  bytes.set(json, MAGIC.length + 4);
  return bytes;
}

/**
 * The bytes of one record, to append after the header.
 */
export function encodeRecordingRecord(record: RecordingRecord): Uint8Array {
  const payload = payloadOf(record);
  const bytes = new Uint8Array(RECORD_HEADER_SIZE + payload.byteLength);
  const view = new DataView(bytes.buffer);
  view.setUint8(0, RECORD_KIND[record.kind]);
  view.setUint32(4, payload.byteLength, true);
  bytes.set(payload, RECORD_HEADER_SIZE);
  return bytes;
}

/**
 * Lay out a whole recording.
 */
export function serializeRecording(recording: Recording): Uint8Array {
  return concat([
    encodeRecordingHeader(recording.header),
    ...recording.records.map((record) => encodeRecordingRecord(record)),
  ]);
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

function decodeRecord(kind: number, payload: Uint8Array): RecordingRecord | undefined {
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);

  switch (kind) {
    case RECORD_KIND.epoch:
      return { kind: 'epoch', epoch: decodeEpoch(view) };
    case RECORD_KIND.block:
      return { kind: 'block', block: decodeBlock(payload) };
    case RECORD_KIND.gap:
      return { kind: 'gap', gap: decodeGap(view) };
    case RECORD_KIND.boundary:
      return { kind: 'boundary', boundary: decodeBoundary(view) };
    default:
      return undefined;
  }
}

/**
 * Read a whole recording. A recording cut short in the middle of a record still gives the
 * records before it, with {@link Recording.truncatedAt} saying where it was cut.
 *
 * @throws If the bytes are not a recording, the version is not 1, or a record is malformed.
 */
export function deserializeRecording(bytes: Uint8Array): Recording {
  const { header, end } = decodeHeader(bytes);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const records: RecordingRecord[] = [];
  let offset = end;

  while (offset < bytes.byteLength) {
    const start = offset + RECORD_HEADER_SIZE;
    const size = start > bytes.byteLength ? 0 : view.getUint32(offset + 4, true);

    if (start + size > bytes.byteLength) {
      return { header, records, truncatedAt: offset };
    }

    const kind = view.getUint8(offset);
    const record = decodeRecord(kind, bytes.subarray(start, start + size));

    if (record) {
      records.push(record);
    }

    offset = start + size;
  }

  return { header, records };
}
