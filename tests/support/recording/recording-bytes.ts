import {
  decodeLocated,
  encodeRecordingHeader,
  encodeRecordingRecord,
  scanRecording,
  type RecordingDamage,
  type RecordingFile,
  type RecordingHeader,
  type RecordingRecord,
} from '@/recording';

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
 * Read a whole recording. A recording cut short, or whose last record is damaged, still gives
 * the records before, with `truncatedAt` saying where it ends; a damaged record in the middle is
 * skipped and listed in `damaged`.
 *
 * @throws If the bytes are not a recording, or not of the current version.
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

/**
 * Every byte a recording file holds.
 */
export async function fileBytes(file: RecordingFile): Promise<Uint8Array> {
  return file.read(0, await file.size());
}
