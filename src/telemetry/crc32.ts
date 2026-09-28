const TABLE = new Uint32Array(256).map((_, byte) => {
  let value = byte;

  for (let bit = 0; bit < 8; bit++) {
    value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }

  return value;
});

/**
 * The CRC-32 of some bytes, as zlib and PNG compute it (IEEE 802.3, reflected).
 *
 * @param bytes The bytes.
 * @param previous The CRC-32 of the bytes before them, to go on from.
 */
export function crc32(bytes: Uint8Array, previous = 0): number {
  let crc = (previous ^ 0xffffffff) >>> 0;

  for (const byte of bytes) {
    crc = TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }

  return (crc ^ 0xffffffff) >>> 0;
}
