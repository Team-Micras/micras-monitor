/**
 * What the windows ask the link to stream. Each window kind says which of its variables it
 * wants and how often; the stream planner gathers the demands of the visible windows, adds the
 * pinned roles of the robot package and fits them into the measured budget of the link.
 *
 * @module
 */

/** A variable a window wants streamed, and how often it wants a new sample. */
export interface StreamDemand {
  /** The variable, by name. */
  readonly variable: string;
  /** Samples per second the window can use; the planner may grant fewer. */
  readonly rateHz: number;
}

/** The rate a window asks for when its kind does not say. */
export const DEFAULT_STREAM_RATE_HZ = 10;
