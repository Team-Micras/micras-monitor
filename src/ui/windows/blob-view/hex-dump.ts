/**
 * Bytes as a hexadecimal dump, for blobs of a type no package decodes.
 *
 * @module
 */

/** One line of a dump. */
export interface HexRow {
  /** The offset of the first byte, as four hexadecimal digits. */
  readonly offset: string;
  /** The bytes, two digits each, separated by spaces. */
  readonly hex: string;
  /** The bytes as printable ASCII, a dot for the others. */
  readonly ascii: string;
}

const PRINTABLE_FIRST = 0x20;
const PRINTABLE_LAST = 0x7e;

/**
 * Splits bytes into lines of a dump.
 *
 * @param bytes The bytes.
 * @param width How many bytes per line; 16 by default.
 */
export function hexRows(bytes: Uint8Array, width = 16): readonly HexRow[] {
  const rows: HexRow[] = [];

  for (let start = 0; start < bytes.length; start += width) {
    const line = bytes.subarray(start, start + width);
    rows.push({
      offset: start.toString(16).padStart(4, '0'),
      hex: Array.from(line, (byte) => byte.toString(16).padStart(2, '0')).join(' '),
      ascii: Array.from(line, (byte) =>
        byte >= PRINTABLE_FIRST && byte <= PRINTABLE_LAST ? String.fromCodePoint(byte) : '.'
      ).join(''),
    });
  }

  return rows;
}
