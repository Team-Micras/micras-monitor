/**
 * Check this side of the protocol against the frames the firmware produces.
 *
 * Run with `npm run check:protocol`.
 */

import { encodeFrame, FrameReader } from '../Frame';
import { FRAME_VECTORS } from './frameVectors';
import * as Cobs from '../Cobs';

function fail(message: string): never {
  console.error(`FAIL ${message}`);
  process.exit(1);
}

function same(a: Uint8Array | number[], b: Uint8Array | number[]): boolean {
  return a.length === b.length && [...a].every((value, index) => value === b[index]);
}

for (const vector of FRAME_VECTORS) {
  const encoded = encodeFrame(vector.type, new Uint8Array(vector.payload));

  if (!same(encoded, vector.frame)) {
    fail(
      `${vector.name}: encoded [${encoded}] but the firmware produces [${vector.frame}]`
    );
  }

  const reader = new FrameReader();
  const frames = reader.push(new Uint8Array(vector.frame));

  if (frames.length !== 1) {
    fail(`${vector.name}: the firmware's frame did not decode to exactly one message`);
  }

  if (frames[0].type !== vector.type || !same(frames[0].payload, vector.payload)) {
    fail(`${vector.name}: decoded to a different message than it was built from`);
  }
}

// A frame that lost a byte is discarded, and the next one still arrives
{
  const good = encodeFrame(
    FRAME_VECTORS[3].type,
    new Uint8Array(FRAME_VECTORS[3].payload)
  );
  const torn = good.slice(0, good.length - 3);
  const reader = new FrameReader();
  const frames = reader.push(new Uint8Array([...torn, 0x00, ...good]));

  if (frames.length !== 1 || reader.discarded !== 1) {
    fail('a truncated frame was not discarded on its own');
  }
}

// An encoded frame never contains the delimiter, whatever the payload is
for (let size = 0; size < 200; size++) {
  const payload = new Uint8Array(size).map((_, index) => (index * 37) % 256);
  const encoded = Cobs.encode(payload);

  if (encoded.includes(Cobs.DELIMITER)) {
    fail(`a payload of ${size} bytes encoded to something containing a delimiter`);
  }

  if (!same(Cobs.decode(encoded) ?? [], payload)) {
    fail(`a payload of ${size} bytes did not survive the round trip`);
  }
}

console.log(
  `protocol ok: ${FRAME_VECTORS.length} frames match the firmware byte for byte`
);
