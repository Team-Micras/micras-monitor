/**
 * The port the plots and the Robot window read stored samples through. It is the querying side
 * of the telemetry store, which implements it as it is.
 *
 * @module
 */

import type {
  DecimateOptions,
  Decimation,
  Gap,
  SampleRun,
  SampleValue,
  TimeRange,
} from '@/telemetry';

export type { DecimateOptions, Decimation, Gap, SampleRun, SampleValue, TimeRange };

/** The stored history of the robot's variables, by name. Times are on the session timeline. */
export interface HistoryPort {
  /**
   * The minimum and maximum of a variable per pixel column of `[startUs, endUs)`, with where
   * its line breaks; asked again with the previous result, only the changed columns are redone.
   */
  decimate(
    variable: string,
    startUs: number,
    endUs: number,
    pixels: number,
    options?: DecimateOptions
  ): Decimation;

  /** Why a variable has no samples in parts of `[startUs, endUs)`, ordered by start. */
  gaps(variable: string, startUs: number, endUs: number): readonly Gap[];

  /**
   * The span of the kept history of a variable, or of the whole session when none is named,
   * holding its last sample; the same object until it changes.
   */
  timeRange(variable?: string): TimeRange | undefined;

  /** The stored sample at a time, or the last one before it. */
  valueAt(variable: string, timeUs: number): SampleValue | undefined;

  /** The stored samples in `[startUs, endUs)`, as views valid until the next append. */
  samples(variable: string, startUs: number, endUs: number): Iterable<SampleRun>;

  /**
   * Calls `listener` after any of the variables changed, at most once per tick of the store;
   * returns the function that stops it.
   */
  subscribe(variables: readonly string[], listener: () => void): () => void;
}
