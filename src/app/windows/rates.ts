/**
 * The rates the window kinds ask the link to stream at.
 *
 * @module
 */

/** Samples per second a window asks for when its kind does not say. */
export const DEFAULT_STREAM_RATE_HZ = 10;

/** Samples per second a plot asks for: a control loop's signals, drawn smoothly. */
export const PLOT_RATE_HZ = 100;

/** Samples per second a readout or the Robot window asks for: numbers change ten times a second. */
export const READOUT_RATE_HZ = 10;

/** Samples per second the Robot window asks for the battery: it drains over minutes. */
export const BATTERY_RATE_HZ = 1;

/** Samples per second an editor asks for, to see the confirmed value soon after a write. */
export const EDITOR_RATE_HZ = 5;

/** Samples per second a type view asks of the revision of its blob, to read it again soon. */
export const REVISION_RATE_HZ = 2;

/** Samples per second a type view asks of each role it follows, such as the pose over a map. */
export const FOLLOW_RATE_HZ = 10;
