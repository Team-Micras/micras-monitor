/**
 * Every sample of the session in memory, and what the interface reads from it: latest values,
 * sample runs, decimated windows for the plots, gaps, and the recording format.
 *
 * It depends only on the protocol's types. The session feeds it through its own ingestion API,
 * and the application gives it a scheduler, so it runs the same in the browser, in Node and in
 * tests.
 *
 * @module
 */

export {
  COLUMN_BREAKS,
  COLUMN_HAS_DATA,
  COLUMN_HAS_NAN,
  Decimation,
  type DecimationStats,
} from './decimation';
export { MemoryBlockPersistence } from './memory-persistence';
export type { BlockPersistence, BlockRef, PersistedBlock, PersistedColumn } from './persistence';
export {
  decodeBlock,
  deserializeRecording,
  encodeBlock,
  encodeRecordingHeader,
  encodeRecordingRecord,
  RECORDING_FORMAT,
  RECORDING_FORMAT_VERSION,
  serializeRecording,
  type RecordedGap,
  type Recording,
  type RecordingHeader,
  type RecordingRecord,
  type RecordingVariable,
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
  DEFAULT_MEMORY_CAP_BYTES,
  TelemetryStore,
  type DecimateOptions,
  type TelemetryStoreOptions,
  type TimeRange,
  type VariableInfo,
} from './store';
export type {
  Boundary,
  BoundaryKind,
  EpochSpec,
  Gap,
  GapKind,
  LatestValue,
  NumericColumn,
  SampleRun,
  StoreStatus,
  TelemetryEvent,
  TelemetryValue,
  VariableSpec,
} from './types';
