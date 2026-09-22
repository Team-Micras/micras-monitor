/**
 * CRC-16/CCITT-FALSE, over a nibble table, matching `micras_core/src/crc.cpp` in the firmware.
 *
 * It is not protecting against the radio, which has a CRC-24 of its own and retransmits until
 * acknowledged. It covers the two hops BLE never sees: the 8N1 serial port with no parity between
 * the microcontroller and the module, and the module's buffer, which drops runs of bytes with no
 * indication that it did.
 */

const TABLE = [
  0x0000, 0x1021, 0x2042, 0x3063, 0x4084, 0x50a5, 0x60c6, 0x70e7, 0x8108, 0x9129, 0xa14a,
  0xb16b, 0xc18c, 0xd1ad, 0xe1ce, 0xf1ef,
];

/**
 * Compute the frame check of a buffer.
 *
 * @param data The bytes to check.
 * @returns The check value.
 */
export function crc16(data: Uint8Array): number {
  let crc = 0xffff;

  for (const byte of data) {
    crc = ((crc << 4) & 0xffff) ^ TABLE[((crc >> 12) ^ (byte >> 4)) & 0x0f];
    crc = ((crc << 4) & 0xffff) ^ TABLE[((crc >> 12) ^ (byte & 0x0f)) & 0x0f];
  }

  return crc;
}
