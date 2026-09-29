/**
 * What the windows ask the link to stream. Each window kind says which of its variables it
 * wants and how often; the stream planner gathers the demands of the visible windows, adds the
 * pinned roles of the robot package and fits them into the measured budget of the link.
 *
 * @module
 */

import type { Role } from '@/robot-kit';

/** A variable a window wants streamed, and how often it wants a new sample. */
export interface StreamDemand {
  /** The variable, by name. */
  readonly variable: string;
  /** Samples per second the window can use; the planner may grant fewer. */
  readonly rateHz: number;
}

/** The rate a window asks for when its kind does not say. */
export const DEFAULT_STREAM_RATE_HZ = 10;

/** A variable the robot package pins by role, so it streams whichever windows are visible. */
export interface PinnedDemand extends StreamDemand {
  /** The role that pins it. */
  readonly role: Role;
}

/** Everything the app wants streamed at a moment. */
export interface StreamRequest {
  /** What the visible windows ask for; a variable may appear more than once. */
  readonly windows: readonly StreamDemand[];
  /** What the robot package pins by role; the planner cuts these last when the budget is short. */
  readonly pinned: readonly PinnedDemand[];
}

/** Takes what the app wants streamed; the stream planner fits it into the budget of the link. */
export interface StreamPort {
  /**
   * Replaces what is wanted. The planner applies it after a short pause, so a burst of layout
   * changes plans once.
   */
  request(request: StreamRequest): void;
}
