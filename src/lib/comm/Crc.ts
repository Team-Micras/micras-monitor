/**
 * CRC-16/CCITT-FALSE, matching `micras_core/include/micras/core/crc.hpp` in the firmware.
 *
 * It is not protecting against the radio, which has a CRC-24 of its own and retransmits until
 * acknowledged. It covers the two hops BLE never sees: the 8N1 serial port with no parity between
 * the microcontroller and the module, and the module's buffer, which drops runs of bytes with no
 * indication that it did.
 */

const POLYNOMIAL = 0x1021;

/**
 * Compute the frame check of a buffer.
 *
 * @param data The bytes to check.
 * @returns The check value.
 */
export function crc16(data: Uint8Array): number {
  let crc = 0xffff;

  for (const byte of data) {
    crc ^= byte << 8;

    for (let bit = 0; bit < 8; bit++) {
      crc = (crc & 0x8000) !== 0 ? ((crc << 1) ^ POLYNOMIAL) & 0xffff : (crc << 1) & 0xffff;
    }
  }

  return crc;
}
