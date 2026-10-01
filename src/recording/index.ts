/**
 * The recording format and its files: what REC writes while the robot streams, and how a saved
 * recording is scanned, checked and read back into a history.
 *
 * It depends only on `src/core` and on the history it records.
 *
 * @module
 */

export type { RecordingRecord } from '@/history/types';
export {
  decodeBlock,
  decodeRecordingHeader,
  encodeBlock,
  encodeRecordingHeader,
  peekBlock,
  RECORDING_FORMAT,
  RECORDING_FORMAT_VERSION,
  type RecordingHeader,
} from './codec';
export { loadRecording, type LoadedRecording, type StoredRecording, type StoredRun } from './load';
export { MemoryRecordingFile, type RecordingFile } from './recording-file';
export {
  RecordingBlocks,
  RecordingReader,
  type BlockLocation,
  type RecordingSummary,
} from './recording-reader';
export { RecordingWriter, type RecordingWriterStats } from './recording-writer';
export {
  decodeLocated,
  encodeRecordingRecord,
  scanRecording,
  type LocatedRecord,
  type RecordingDamage,
  type RecordingScan,
} from './scan';
