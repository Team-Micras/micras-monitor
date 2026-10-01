import v2 from '@tests/support/sources/micras-comm/v2.json';

/**
 * One message and the exact bytes the firmware puts on the wire for it.
 */
export interface FrameVector {
  /** Name of the vector in `tests/host/vectors/v2.json`. */
  readonly name: string;

  /** The message type byte. */
  readonly type: number;

  /** The payload before framing. */
  readonly payload: readonly number[];

  /** The framed bytes, delimiter included. */
  readonly frame: readonly number[];

  /** What the payload says, field by field, under the firmware's names, when it is a message. */
  readonly fields?: Readonly<Record<string, unknown>>;
}

/** The protocol version the vectors were produced for. */
export const VECTORS_PROTOCOL_VERSION: number = v2.protocol_version;

/**
 * The frames the firmware's own codec produces, byte for byte.
 *
 * Every writer and reader disagreement this project has had was invisible until something was on
 * the wire. These vectors are `tests/host/vectors/v2.json` of `micras_comm`, copied unchanged, so
 * that the two implementations cannot drift apart without a test saying so.
 */
export const FRAME_VECTORS: readonly FrameVector[] = v2.vectors;

/**
 * The vector with a name.
 *
 * @throws If there is none.
 */
export function vectorNamed(name: string): FrameVector {
  const vector = FRAME_VECTORS.find((candidate) => candidate.name === name);

  if (!vector) {
    throw new Error(`No frame vector named ${name}`);
  }

  return vector;
}
