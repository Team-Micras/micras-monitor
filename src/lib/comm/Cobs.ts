/**
 * Consistent Overhead Byte Stuffing, matching `micras_core/src/cobs.cpp` in the firmware.
 *
 * An encoded frame cannot contain a zero byte by construction, so a zero delimits frames and
 * resynchronising after the radio module has silently dropped a run of bytes is a matter of
 * scanning to the next one. The overhead is one byte every 254 against up to one byte per byte for
 * escaping, and there are no reserved values to work around anywhere else in the format.
 */

export const DELIMITER = 0x00;

/**
 * The largest size the encoding of a buffer can have.
 *
 * @param size Number of bytes of the data.
 * @returns Number of bytes the encoded data can take at most.
 */
export function encodedSize(size: number): number {
  return size + Math.floor(size / 254) + 1;
}

/**
 * Encode a buffer so that it contains no delimiter byte.
 *
 * @param from The data to encode.
 * @returns The encoded data, with no delimiter around it.
 */
export function encode(from: Uint8Array): Uint8Array {
  const into = new Uint8Array(encodedSize(from.length));

  let codeIndex = 0;
  let writeIndex = 1;
  let code = 1;

  for (const byte of from) {
    if (byte !== DELIMITER) {
      into[writeIndex++] = byte;

      if (++code !== 0xff) {
        continue;
      }
    }

    into[codeIndex] = code;
    codeIndex = writeIndex++;
    code = 1;
  }

  if (from.length > 0 && from[from.length - 1] !== DELIMITER && code === 1) {
    return into.subarray(0, writeIndex - 1);
  }

  into[codeIndex] = code;
  return into.subarray(0, writeIndex);
}

/**
 * Decode a frame that was encoded by `encode`.
 *
 * @param from The encoded frame, without any delimiter.
 * @returns The decoded data, or null if the frame is malformed.
 */
export function decode(from: Uint8Array): Uint8Array | null {
  const into = new Uint8Array(from.length);

  let readIndex = 0;
  let writeIndex = 0;

  while (readIndex < from.length) {
    const code = from[readIndex];

    if (code === DELIMITER || readIndex + code > from.length) {
      return null;
    }

    readIndex++;

    for (let i = 1; i < code; i++) {
      into[writeIndex++] = from[readIndex++];
    }

    if (code !== 0xff && readIndex < from.length) {
      into[writeIndex++] = DELIMITER;
    }
  }

  return into.subarray(0, writeIndex);
}
