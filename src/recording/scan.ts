import type { RecordingRecord } from '@/history/types';

import { ByteWriter } from './bytes';
import {
  decodePayload,
  decodeRecordingHeader,
  encodePayload,
  peekBlock,
  recordCode,
  recordKindOf,
  type RecordingHeader,
} from './codec';
import { crc32 } from './crc32';

/**
 * The framing of the records of a recording and how a reader finds them again.
 *
 * Every record starts with its kind, three reserved bytes, its size and a CRC-32 that covers
 * those eight bytes and then the payload, so that a damaged size cannot send a reader astray. A
 * record that fails its check is skipped up to the next record that passes one, and reported;
 * with none after it, it is where the recording was cut short. A record that passes its check but
 * does not decode is skipped and reported, unless it is the last one, which is also taken as a
 * cut. The layout of the header and the payloads is in `codec.ts`.
 *
 * @module
 */

/** How many bytes a record's own header takes before its payload. */
export const RECORD_OVERHEAD = 12;

const RECORD_CHECKED_SIZE = 8;

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
 * A record found in the bytes of a recording, not decoded yet.
 */
export interface LocatedRecord {
  /** The record's kind; unknown kinds are left out. */
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

  /**
   * Where the last, incomplete record starts, when the recording was cut short, as when the tab
   * closed in the middle of a write. The records before it are whole.
   */
  readonly truncatedAt?: number;

  /** Records skipped in the middle of the recording because they were damaged. */
  readonly damaged?: readonly RecordingDamage[];
}

/**
 * The bytes of one record, to append after the header.
 */
export function encodeRecordingRecord(record: RecordingRecord): Uint8Array {
  const payload = encodePayload(record);
  const head = new ByteWriter(RECORD_CHECKED_SIZE)
    .u8(recordCode(record.kind))
    .skip(3)
    .u32(payload.byteLength, 'Record size')
    .done();
  return new ByteWriter(RECORD_OVERHEAD + payload.byteLength)
    .raw(head)
    .u32(crc32(payload, crc32(head)), 'Record check')
    .raw(payload)
    .done();
}

/**
 * Find the records of a recording without decoding their samples, for a reader that decodes
 * blocks only when it needs them. A recording cut short, or whose last record is damaged, still
 * gives the records before; a damaged record in the middle is skipped and listed.
 *
 * @throws If the bytes are not a recording, or not of the current version.
 */
export function scanRecording(bytes: Uint8Array): RecordingScan {
  const { header, end } = decodeRecordingHeader(bytes);
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

    const kind = recordKindOf(view.getUint8(offset));
    const payload = bytes.subarray(offset + RECORD_OVERHEAD, stop);
    const problem = kind === undefined ? undefined : problemOf(kind, payload);

    if (problem !== undefined) {
      if (stop === bytes.byteLength) {
        truncatedAt = offset;
        break;
      }

      damaged.push({ offset, reason: problem });
    } else if (kind !== undefined) {
      records.push({ kind, offset, payload });
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
  try {
    return decodePayload(record.kind, record.payload);
  } catch (error) {
    throw new Error(`Record at ${record.offset} does not decode: ${messageOf(error)}`, {
      cause: error,
    });
  }
}

function problemOf(kind: RecordingRecord['kind'], payload: Uint8Array): string | undefined {
  try {
    if (kind === 'block') {
      peekBlock(payload);
    } else {
      decodePayload(kind, payload);
    }

    return undefined;
  } catch (error) {
    return messageOf(error);
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function checkedEnd(bytes: Uint8Array, view: DataView, offset: number): number | undefined {
  const stop = recordEnd(bytes, view, offset);

  if (stop === undefined) {
    return undefined;
  }

  const head = crc32(bytes.subarray(offset, offset + RECORD_CHECKED_SIZE));
  const payload = bytes.subarray(offset + RECORD_OVERHEAD, stop);
  return crc32(payload, head) === view.getUint32(offset + 8, true) ? stop : undefined;
}

function recordEnd(bytes: Uint8Array, view: DataView, offset: number): number | undefined {
  const start = offset + RECORD_OVERHEAD;

  if (start > bytes.byteLength) {
    return undefined;
  }

  const stop = start + view.getUint32(offset + 4, true);
  return stop > bytes.byteLength ? undefined : stop;
}

function plausibleHeader(bytes: Uint8Array, offset: number): boolean {
  return (
    offset + RECORD_OVERHEAD <= bytes.byteLength &&
    recordKindOf(bytes[offset]) !== undefined &&
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

  for (let offset = from; offset + RECORD_OVERHEAD <= bytes.byteLength; offset++) {
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
