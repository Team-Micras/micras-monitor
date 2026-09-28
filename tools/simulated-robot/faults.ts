/**
 * What can be made to go wrong between the simulated robot and the monitor, and what did.
 *
 * @module
 */

/** The link the simulated robot runs over, and the faults injected into it. Nothing by default. */
export interface FaultOptions {
  /** The most bytes per second the robot's radio carries; unlimited when 0. */
  throughputBytesPerSecond: number;

  /** Added to each direction, in milliseconds, so the round trip grows by twice this. */
  latencyMs: number;

  /** Lose this schema page, counting pages sent from 0, once; the robot still charges for it. */
  dropSchemaPage: number | null;

  /** Ignore this many CREDIT frames once samples are flowing. */
  dropCredits: number;

  /** The share of outgoing frames, from 0 to 1, that arrive with a bad frame check. */
  corruptRate: number;

  /** Reset the robot this many seconds after the monitor connects, once, keeping the link up. */
  rebootAfterSeconds: number | null;

  /** Seeds the choice of frames to corrupt, so that a run can be repeated. */
  seed: number;
}

/** A link with nothing wrong with it. */
export const NO_FAULTS: FaultOptions = {
  throughputBytesPerSecond: 0,
  latencyMs: 0,
  dropSchemaPage: null,
  dropCredits: 0,
  corruptRate: 0,
  rebootAfterSeconds: null,
  seed: 1,
};

/** What the simulated robot did, for tests to compare against what the monitor saw. */
export interface RobotStats {
  hellos: number;
  samplesSent: number;
  /** Samples the robot had no credit for. */
  samplesDropped: number;
  /** Bytes charged to the credit window, lost pages included. */
  meteredBytes: number;
  schemaPagesDropped: number;
  corruptedFrames: number;
  /** Bytes of metered frames that were corrupted, which the monitor must not give credit for. */
  corruptedMeteredBytes: number;
  /** Credit the robot received and applied. */
  creditReceived: number;
  creditFramesDropped: number;
  reboots: number;
}

/** A robot that has done nothing yet. */
export function emptyRobotStats(): RobotStats {
  return {
    hellos: 0,
    samplesSent: 0,
    samplesDropped: 0,
    meteredBytes: 0,
    schemaPagesDropped: 0,
    corruptedFrames: 0,
    corruptedMeteredBytes: 0,
    creditReceived: 0,
    creditFramesDropped: 0,
    reboots: 0,
  };
}

/**
 * A small seeded generator (mulberry32), so that which frames get corrupted repeats run to run.
 *
 * @param seed Any 32 bit integer.
 * @returns A function returning numbers in [0, 1).
 */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;

  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 2 ** 32;
  };
}
