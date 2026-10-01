import { isValueType, type Access, type Value, type Variable } from '@/core/variables';
import type { BlockRef, BlockData, ColumnData } from '@/history/block-backing';
import { allocateColumn, bytesPerValue, type ColumnKind, kindOfColumn } from '@/history/columns';
import type { BoundaryKind, RecordedGap, RecordingRecord } from '@/history/types';

import { ByteReader, ByteWriter } from './bytes';

/**
 * Recording format, version 2.
 *
 * A recording is a header followed by records, so that a recorder can append records as they
 * happen. Every number is little endian; a string is a `u32` byte count and UTF-8.
 *
 * ```
 * magic         8 bytes   89 4D 4D 52 45 43 0D 0A  ("\x89MMREC\r\n")
 * header size   u32
 * header        UTF-8 JSON, a RecordingHeader
 * records       repeated until the end:
 *   kind        u8        1 run, 2 block, 3 gap, 4 boundary, 5 value, 6 run closed;
 *                         unknown kinds are skipped
 *   reserved    3 bytes
 *   size        u32       bytes of the payload
 *   check       u32       CRC-32 of the kind, reserved and size bytes, then the payload
 *   payload
 * ```
 *
 * Payloads:
 *
 * - run: `u32` run id, `u32` slot, `u32` count, then per variable `u32` id, the type by
 *   its name (`u8`, `f32`, `bytes`…) and the variable's name.
 * - block: `u32` run id, `u32` block index, `u32` start sample, `u32` length `n`, `u32` column
 *   count, then per column `u32` variable id, `u8` kind (0 f32, 1 f64) and 3 reserved bytes; then
 *   `n` f64 times, then each column's `n` values.
 * - gap: `u32` run id, `u8` kind (0 dropped, 1 not stored), 3 reserved bytes, `u32` index, `u32`
 *   count, `f64` start, `f64` time before, `f64` time after (NaN if unknown).
 * - boundary: `u8` kind (0 reconnect, 1 reboot, 2 schema), 7 reserved bytes, `f64` time.
 * - value: `u32` variable id, the name, `f64` time (NaN if unknown), `u8` tag, then by tag: 0 an
 *   `f64`, 1 a `u8` boolean, 2 a 64 bit integer as a decimal string, 3 `u32` count and bytes.
 * - run closed: `u32` run id.
 *
 * This module lays out the header and the payloads; `scan.ts` frames the records and finds them
 * again in a file that may be cut short or damaged. A recording of any other version is refused:
 * the format keeps no compatibility with older ones, and version 1 spelled types with the codes
 * of the robot's protocol.
 *
 * Records need not come in time order. Blocks written back from an earlier recording come after
 * newer ones, so a reader places each block by its run and index. A gap may be written again
 * as it grows, as when the memory cap lets go of more of the stretch before it: a later gap
 * record with the run and start of an earlier one replaces it. The header's optional `name` is
 * the name the session had when the file was written or exported.
 *
 * @module
 */

/** The version this module writes and reads. */
export const RECORDING_FORMAT_VERSION = 2;

/** The name in every header, to tell a recording from other JSON. */
export const RECORDING_FORMAT = 'micras-monitor-recording';

const MAGIC = new Uint8Array([0x89, 0x4d, 0x4d, 0x52, 0x45, 0x43, 0x0d, 0x0a]);

const RECORD_KINDS: readonly RecordingRecord['kind'][] = [
  'run',
  'block',
  'gap',
  'boundary',
  'value',
  'run-closed',
];
const COLUMN_KINDS: readonly ColumnKind[] = ['f32', 'f64'];
const GAP_KINDS: readonly RecordedGap['kind'][] = ['dropped', 'not-stored'];
const BOUNDARY_KINDS: readonly BoundaryKind[] = ['reconnect', 'reboot', 'schema'];
const VALUE_TAG = { number: 0, boolean: 1, bigint: 2, bytes: 3 } as const;

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
  readonly schema: readonly Variable[];

  /** The session's name, as the user gave it. */
  readonly name?: string;
}

/** The kind byte of a record. */
export function recordCode(kind: RecordingRecord['kind']): number {
  return RECORD_KINDS.indexOf(kind) + 1;
}

/** The kind a record's kind byte stands for, or undefined for a kind this version does not know. */
export function recordKindOf(code: number): RecordingRecord['kind'] | undefined {
  return code >= 1 && code <= RECORD_KINDS.length ? RECORD_KINDS[code - 1] : undefined;
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

function isAccess(value: unknown): value is Access {
  return (
    isObject(value) &&
    typeof value.stream === 'boolean' &&
    typeof value.write === 'boolean' &&
    typeof value.writeNeedsIdle === 'boolean' &&
    typeof value.persists === 'boolean'
  );
}

function isVariable(value: unknown): value is Variable {
  return (
    isObject(value) &&
    typeof value.id === 'number' &&
    typeof value.name === 'string' &&
    isValueType(value.type) &&
    isAccess(value.access) &&
    (value.tag === undefined || typeof value.tag === 'string')
  );
}

function parseHeader(json: string): RecordingHeader {
  const value: unknown = JSON.parse(json);

  if (!isObject(value) || value.format !== RECORDING_FORMAT) {
    throw new Error('Recording header is not a monitor recording header');
  }

  if (value.version !== RECORDING_FORMAT_VERSION) {
    throw new Error(
      `The recording is in format version ${String(value.version)}; this monitor reads only version ${RECORDING_FORMAT_VERSION}`
    );
  }

  const { startedAtMs, robot, schema, name } = value;

  if (
    typeof startedAtMs !== 'number' ||
    !isRobotInfo(robot) ||
    !Array.isArray(schema) ||
    !schema.every(isVariable) ||
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
 * The header of a recording and where the records after it start.
 *
 * @throws If the bytes are not a recording, or not of {@link RECORDING_FORMAT_VERSION}.
 */
export function decodeRecordingHeader(bytes: Uint8Array): {
  readonly header: RecordingHeader;
  readonly end: number;
} {
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

/**
 * Lay out the samples of a block, as the payload of a block record.
 */
export function encodeBlock(block: BlockData): Uint8Array {
  const length = block.time.length;
  let size = 20 + 8 * block.columns.length + 8 * length;

  for (const column of block.columns) {
    size += column.values.byteLength;
  }

  const writer = new ByteWriter(size)
    .u32(block.ref.runId, 'Run id')
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
  const ref = { runId: reader.u32(), index: reader.u32() };
  reader.u32();
  const length = reader.u32();
  readLayout(reader, bytes.byteLength, length);
  return { ref, length };
}

/**
 * Read back the payload of a block record, into arrays of exactly its length.
 *
 * @throws If the payload is truncated, too long or names an unknown column kind.
 */
export function decodeBlock(bytes: Uint8Array): BlockData {
  const reader = new ByteReader(bytes);
  const ref = { runId: reader.u32(), index: reader.u32() };
  const startSample = reader.u32();
  const length = reader.u32();
  const layout = readLayout(reader, bytes.byteLength, length);
  const time = new Float64Array(length);

  for (let index = 0; index < length; index++) {
    time[index] = reader.f64();
  }

  const columns: ColumnData[] = layout.map(({ variableId, kind }) => {
    const values = allocateColumn(kind, length);

    for (let index = 0; index < length; index++) {
      values[index] = kind === 'f32' ? reader.f32() : reader.f64();
    }

    return { variableId, values };
  });

  return { ref, startSample, time, columns };
}

function readLayout(
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

function encodeValue(writer: ByteWriter, value: Value): void {
  if (typeof value === 'number') {
    writer.u8(VALUE_TAG.number).f64(value);
  } else if (typeof value === 'boolean') {
    writer.u8(VALUE_TAG.boolean).u8(value ? 1 : 0);
  } else if (typeof value === 'bigint') {
    writer.u8(VALUE_TAG.bigint).text(value.toString());
  } else {
    writer.u8(VALUE_TAG.bytes).u32(value.byteLength, 'Blob size').raw(value);
  }
}

function decodeValue(reader: ByteReader): Value {
  const tag = reader.u8();

  switch (tag) {
    case VALUE_TAG.number:
      return reader.f64();
    case VALUE_TAG.boolean:
      return reader.u8() !== 0;
    case VALUE_TAG.bigint:
      return BigInt(reader.text());
    case VALUE_TAG.bytes:
      return reader.raw(reader.u32());
    default:
      throw new Error(`Unknown value tag ${tag} in recording`);
  }
}

/**
 * The payload of a record.
 *
 * @throws If a value does not fit its field, or a kind is unknown.
 */
export function encodePayload(record: RecordingRecord): Uint8Array {
  if (record.kind === 'block') {
    return encodeBlock(record.block);
  }

  const writer = new ByteWriter();

  if (record.kind === 'run') {
    const { run } = record;
    writer
      .u32(run.runId, 'Run id')
      .u32(run.slot, 'Slot')
      .u32(run.variables.length, 'Variable count');

    for (const variable of run.variables) {
      writer.u32(variable.id, 'Variable id').text(variable.type).text(variable.name);
    }
  } else if (record.kind === 'run-closed') {
    writer.u32(record.runId, 'Run id');
  } else if (record.kind === 'gap') {
    const { gap } = record;
    writer
      .u32(gap.runId, 'Run id')
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

/**
 * Read back the payload of a record.
 *
 * @throws If the payload is truncated, too long or holds an unknown kind, type or tag.
 */
export function decodePayload(kind: RecordingRecord['kind'], payload: Uint8Array): RecordingRecord {
  if (kind === 'block') {
    return { kind, block: decodeBlock(payload) };
  }

  const reader = new ByteReader(payload);
  let record: RecordingRecord;

  switch (kind) {
    case 'run': {
      const runId = reader.u32();
      const slot = reader.u32();
      const count = reader.u32();

      if (12 * count > reader.remaining) {
        throw new Error(`Run record cannot hold ${count} variables`);
      }

      const variables = Array.from({ length: count }, () => {
        const id = reader.u32();
        const type = reader.text();

        if (!isValueType(type)) {
          throw new Error(`Unknown value type ${type} in recording`);
        }

        return { id, type, name: reader.text() };
      });
      record = { kind, run: { runId, slot, variables } };
      break;
    }
    case 'run-closed':
      record = { kind, runId: reader.u32() };
      break;
    case 'gap': {
      const runId = reader.u32();
      const gapKind = kindAt(GAP_KINDS, reader.u8(), 'gap kind');
      reader.skip(3);
      record = {
        kind,
        gap: {
          runId,
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
    case 'boundary': {
      const boundaryKind = kindAt(BOUNDARY_KINDS, reader.u8(), 'boundary kind');
      reader.skip(7);
      record = { kind, boundary: { kind: boundaryKind, timeUs: reader.f64() } };
      break;
    }
    case 'value': {
      const variableId = reader.u32();
      const name = reader.text();
      const timeUs = reader.f64();
      record = { kind, value: { variableId, name, timeUs, value: decodeValue(reader) } };
      break;
    }
  }

  reader.end(record.kind);
  return record;
}
