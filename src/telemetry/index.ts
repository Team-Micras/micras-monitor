/**
 * Every sample of the session in memory, and what the interface reads from it: latest values,
 * sample runs, decimated windows for the plots, gaps, and the recording format.
 *
 * It depends only on the model of `src/core`. The session feeds it through its own ingestion API,
 * and the application gives it a scheduler, so it runs the same in the browser, in Node and in
 * tests.
 *
 * @module
 */

export {
  COLUMN_BREAKS,
  COLUMN_HAS_DATA,
  COLUMN_HAS_NAN,
  type Decimation,
  type DecimationStats,
} from './decimation';
export type {
  BlockPersistence,
  BlockRef,
  PersistedBlock,
  PersistedColumn,
  StoredEpoch,
  StoredSession,
} from './persistence';
export {
  RecordingBlocks,
  SessionRecorder,
  type BlockLocation,
  type RecorderStats,
} from './recorder';
export { MemoryRecordingFile, type RecordingFile } from './recording-file';
export { SavedRecording, type RecordingSummary } from './recording-reader';
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
export { ManualScheduler, type Scheduler } from './scheduler';
export {
  toBandSeries,
  toLineSeries,
  type BandSeries,
  type LineSeries,
  type PlotValue,
} from './series';
export type { ColumnKind } from './storage';
export {
  DEFAULT_BLOCK_SIZE,
  DEFAULT_FLUSH_INTERVAL_MS,
  DEFAULT_MEMORY_CAP_BYTES,
  TelemetryStore,
  type DecimateOptions,
  type TelemetryStoreOptions,
  type VariableInfo,
} from './store';
export type {
  Boundary,
  BoundaryKind,
  EpochSpec,
  Gap,
  GapKind,
  HistoryMark,
  IngestionEvent,
  LatestValue,
  NumericColumn,
  RecordedEpoch,
  RecordedGap,
  RecordedValue,
  SampleRun,
  SampleValue,
  HistoryVariable,
  StoreStatus,
  TelemetryEvent,
  TimeRange,
  VariableRef,
  VariableSpec,
} from './types';
export { historyWindow, liveWindow, nextUp } from './window';
