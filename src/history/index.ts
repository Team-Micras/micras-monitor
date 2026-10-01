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
export { type BlockBacking, type BlockRef, type BlockData, type ColumnData } from './block-backing';
export { ManualScheduler, type Scheduler } from './scheduler';
export { nextUp, type ColumnKind } from './columns';
export {
  DEFAULT_BLOCK_SIZE,
  DEFAULT_FLUSH_INTERVAL_MS,
  DEFAULT_MEMORY_CAP_BYTES,
  HistoryStore,
  type HistoryStoreOptions,
} from './history-store';
export type { DecimateOptions, VariableInfo } from './queries';
export type {
  Boundary,
  BoundaryKind,
  StreamRunSpec,
  Gap,
  GapKind,
  HistoryMark,
  LatestValue,
  NumericColumn,
  RecordedRun,
  RecordedGap,
  RecordedValue,
  RecordingRecord,
  SampleRun,
  SampleValue,
  HistoryVariable,
  StoreStatus,
  StoreWarning,
  TimeRange,
  VariableRef,
  VariableSpec,
} from './types';
