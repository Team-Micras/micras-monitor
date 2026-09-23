import { TypeCode } from './Protocol';
import { Fundamental } from './variables/ISerialVariable';

/**
 * Reading and writing the values the schema describes.
 *
 * A type code indexes these tables directly, which is what replaced matching on the strings
 * `type_name<T>()` used to emit. Those were the compiler's spelling of a type, they carried a
 * string table into the firmware for every registered type, and a compiler change silently
 * un-decoded every variable.
 */

export const TYPE_SIZE: Record<TypeCode, number> = {
  [TypeCode.BOOL]: 1,
  [TypeCode.U8]: 1,
  [TypeCode.I8]: 1,
  [TypeCode.U16]: 2,
  [TypeCode.I16]: 2,
  [TypeCode.U32]: 4,
  [TypeCode.I32]: 4,
  [TypeCode.U64]: 8,
  [TypeCode.I64]: 8,
  [TypeCode.F32]: 4,
  [TypeCode.F64]: 8,
  [TypeCode.BLOB]: 0,
};

const TYPE_NAME: Record<TypeCode, string> = {
  [TypeCode.BOOL]: 'bool',
  [TypeCode.U8]: 'u8',
  [TypeCode.I8]: 'i8',
  [TypeCode.U16]: 'u16',
  [TypeCode.I16]: 'i16',
  [TypeCode.U32]: 'u32',
  [TypeCode.I32]: 'i32',
  [TypeCode.U64]: 'u64',
  [TypeCode.I64]: 'i64',
  [TypeCode.F32]: 'f32',
  [TypeCode.F64]: 'f64',
  [TypeCode.BLOB]: 'blob',
};

const RANGE: Partial<Record<TypeCode, { min: number; max: number }>> = {
  [TypeCode.U8]: { min: 0, max: 255 },
  [TypeCode.I8]: { min: -128, max: 127 },
  [TypeCode.U16]: { min: 0, max: 65535 },
  [TypeCode.I16]: { min: -32768, max: 32767 },
  [TypeCode.U32]: { min: 0, max: 4294967295 },
  [TypeCode.I32]: { min: -2147483648, max: 2147483647 },
};

/**
 * The name to show for a type.
 */
export function typeName(type: TypeCode): string {
  return TYPE_NAME[type] ?? 'unknown';
}

/**
 * The value a variable holds before anything has arrived for it.
 */
export function defaultValue(type: TypeCode): Fundamental {
  if (type === TypeCode.BOOL) {
    return false;
  }

  if (type === TypeCode.U64 || type === TypeCode.I64) {
    return BigInt(0);
  }

  return 0;
}

/**
 * Read one value out of a buffer.
 *
 * @param data The bytes holding the value.
 * @param offset Where the value starts.
 * @param type What the schema says it is.
 * @returns The value, or null if the buffer is too short for it.
 */
export function readValue(
  data: Uint8Array,
  offset: number,
  type: TypeCode
): Fundamental | null {
  if (offset + TYPE_SIZE[type] > data.length) {
    return null;
  }

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

  switch (type) {
    case TypeCode.BOOL:
      return view.getUint8(offset) !== 0;
    case TypeCode.U8:
      return view.getUint8(offset);
    case TypeCode.I8:
      return view.getInt8(offset);
    case TypeCode.U16:
      return view.getUint16(offset, true);
    case TypeCode.I16:
      return view.getInt16(offset, true);
    case TypeCode.U32:
      return view.getUint32(offset, true);
    case TypeCode.I32:
      return view.getInt32(offset, true);
    case TypeCode.U64:
      return view.getBigUint64(offset, true);
    case TypeCode.I64:
      return view.getBigInt64(offset, true);
    case TypeCode.F32:
      return view.getFloat32(offset, true);
    case TypeCode.F64:
      return view.getFloat64(offset, true);
    default:
      return null;
  }
}

/**
 * Lay one value out the way the firmware expects to read it back.
 *
 * @param value The value to send.
 * @param type What the schema says it is.
 * @returns The bytes of the value.
 */
export function writeValue(value: Fundamental, type: TypeCode): Uint8Array {
  const buffer = new ArrayBuffer(TYPE_SIZE[type]);
  const view = new DataView(buffer);

  switch (type) {
    case TypeCode.BOOL:
      view.setUint8(0, value ? 1 : 0);
      break;
    case TypeCode.U8:
      view.setUint8(0, Number(value));
      break;
    case TypeCode.I8:
      view.setInt8(0, Number(value));
      break;
    case TypeCode.U16:
      view.setUint16(0, Number(value), true);
      break;
    case TypeCode.I16:
      view.setInt16(0, Number(value), true);
      break;
    case TypeCode.U32:
      view.setUint32(0, Number(value), true);
      break;
    case TypeCode.I32:
      view.setInt32(0, Number(value), true);
      break;
    case TypeCode.U64:
      view.setBigUint64(0, BigInt(value as number), true);
      break;
    case TypeCode.I64:
      view.setBigInt64(0, BigInt(value as number), true);
      break;
    case TypeCode.F32:
      view.setFloat32(0, Number(value), true);
      break;
    case TypeCode.F64:
      view.setFloat64(0, Number(value), true);
      break;
    default:
      return new Uint8Array(0);
  }

  return new Uint8Array(buffer);
}

/**
 * Refuse a value the firmware could only misread.
 *
 * @param value The value to send.
 * @param type What the schema says it is.
 * @throws If the value does not fit the type.
 */
export function validateValue(value: Fundamental, type: TypeCode): void {
  if (type === TypeCode.BOOL) {
    if (typeof value !== 'boolean') {
      throw new Error(`Expected a boolean, got ${typeof value}`);
    }

    return;
  }

  if (typeof value !== 'number' && typeof value !== 'bigint') {
    throw new Error(`Expected a number, got ${typeof value}`);
  }

  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new Error(`Invalid number: ${value}`);
  }

  const range = RANGE[type];

  if (range && (Number(value) < range.min || Number(value) > range.max)) {
    throw new Error(
      `Value out of range for ${typeName(type)}: expected ${range.min} to ${range.max}, got ${value}`
    );
  }
}
