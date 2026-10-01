/**
 * Every sample of the session in memory, and what the interface reads from it: latest values,
 * sample runs, decimated windows for the plots and gaps.
 *
 * It depends only on the model of `src/core`. A source feeds it through the monitor, and the
 * application gives it a scheduler, so it runs the same in the browser, in Node and in tests.
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
  BlockBacking,
  BlockRef,
  BlockData,
  ColumnData,
  StoredEpoch,
  StoredRecording,
} from './block-backing';
export { ManualScheduler, type Scheduler } from './scheduler';
export {
  toBandSeries,
  toLineSeries,
  type BandSeries,
  type LineSeries,
  type PlotValue,
} from './series';
export type { ColumnKind } from './columns';
export {
  DEFAULT_BLOCK_SIZE,
  DEFAULT_FLUSH_INTERVAL_MS,
  DEFAULT_MEMORY_CAP_BYTES,
  HistoryStore,
  type DecimateOptions,
  type HistoryStoreOptions,
  type VariableInfo,
} from './history-store';
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
  StoreWarning,
  TimeRange,
  VariableRef,
  VariableSpec,
} from './types';
export { historyWindow, liveWindow, nextUp } from './window';
