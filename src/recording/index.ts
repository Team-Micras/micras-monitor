/**
 * The recording format and its files: what REC writes while the robot streams, and how a saved
 * recording is scanned, checked and read back into a history.
 *
 * It depends only on `src/core` and on the history it records.
 *
 * @module
 */

export {
  RecordingBlocks,
  RecordingWriter,
  type BlockLocation,
  type RecordingWriterStats,
} from './recording-writer';
export { MemoryRecordingFile, type RecordingFile } from './recording-file';
export { RecordingReader, type RecordingSummary } from './recording-reader';
export {
  decodeBlock,
  decodeRecordingHeader,
  encodeBlock,
  encodeRecordingHeader,
  encodeRecordingRecord,
  peekBlock,
  RECORDING_FORMAT,
  RECORDING_FORMAT_VERSION,
  recordOf,
  scanRecording,
  type RecordingDamage,
  type RecordingHeader,
  type RecordingRecord,
  type RecordingScan,
  type LocatedRecord,
} from './recording';
