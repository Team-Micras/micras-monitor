import { Fundamental } from "./variables/ISerialVariable";

export type CppType =
  | "bool"
  | "char"
  | "unsigned char"
  | "signed char"
  | "short unsigned int"
  | "short int"
  | "unsigned int"
  | "int"
  | "long unsigned int"
  | "long int"
  | "float"
  | "double";

/**
 * CppBinarySerializer provides static methods for serializing and deserializing C++-style primitive types.
 */
export class CppBinarySerializer {
  /**
   * Map of C++ types to TypeScript types
   * Used to convert C++ types to TypeScript types.
   */
  static readonly cppTypeToTsType: Record<string, Fundamental> = {
    bool: false,
    char: "",
    "unsigned char": 0,
    "signed char": 0,
    "short unsigned int": 0,
    "short int": 0,
    "unsigned int": 0,
    int: 0,
    "long unsigned int": BigInt(0),
    "long int": BigInt(0),
    float: 0.0,
    double: 0.0,
  };

  static readonly cppSizes: Record<string, number> = {
    bool: 1,
    char: 1,
    "unsigned char": 1,
    "signed char": 1,
    "short unsigned int": 2,
    "short int": 2,
    "unsigned int": 4,
    int: 4,
    "long unsigned int": 8,
    "long int": 8,
    float: 4,
    double: 8,
  };

  /**
   * Get the size in bytes of a C++ type
   */
  static getCppTypeSize(type: string): number {
    return this.cppSizes[type];
  }

  /**
   * Serialize a value of a given type to a Uint8Array
   */
  static serializeValue(value: any, type: string): Uint8Array {
    const size = this.getCppTypeSize(type);
    const buffer = new ArrayBuffer(size);
    const dataView = new DataView(buffer);
    const littleEndian = true;

    switch (type) {
      case "bool":
        dataView.setUint8(0, value ? 1 : 0);
        break;
      case "char":
        const charValue = value as string;
        dataView.setUint8(0, charValue.charCodeAt(0));
        break;
      case "unsigned char":
        dataView.setUint8(0, value as number);
        break;
      case "signed char":
        dataView.setInt8(0, value as number);
        break;
      case "short unsigned int":
        dataView.setUint16(0, value as number, littleEndian);
        break;
      case "short int":
        dataView.setInt16(0, value as number, littleEndian);
        break;
      case "unsigned int":
        dataView.setUint32(0, value as number, littleEndian);
        break;
      case "int":
        dataView.setInt32(0, value as number, littleEndian);
        break;
      case "long unsigned int":
        dataView.setBigUint64(0, BigInt(value), littleEndian);
        break;
      case "long int":
        dataView.setBigInt64(0, BigInt(value), littleEndian);
        break;
      case "float":
        dataView.setFloat32(0, value as number, littleEndian);
        break;
      case "double":
        dataView.setFloat64(0, value as number, littleEndian);
        break;
      default:
        console.warn("Unknown type:", type);
        return new Uint8Array(0);
    }
    return new Uint8Array(buffer);
  }

  /**
   * Deserialize a value from a Uint8Array based on its C++ type
   */
  static deserializeValue(serialData: Uint8Array, type: string): any {
    const dataView = new DataView(
      serialData.buffer,
      serialData.byteOffset,
      serialData.byteLength
    );
    const littleEndian = true;
    switch (type) {
      case "bool":
        return dataView.getUint8(0) !== 0;
      case "char":
        return String.fromCharCode(dataView.getUint8(0));
      case "unsigned char":
        return dataView.getUint8(0);
      case "signed char":
        return dataView.getInt8(0);
      case "short unsigned int":
        return dataView.getUint16(0, littleEndian);
      case "short int":
        return dataView.getInt16(0, littleEndian);
      case "unsigned int":
        return dataView.getUint32(0, littleEndian);
      case "int":
        return dataView.getInt32(0, littleEndian);
      case "long unsigned int":
        return dataView.getBigUint64(0, littleEndian);
      case "long int":
        return dataView.getBigInt64(0, littleEndian);
      case "float":
        return dataView.getFloat32(0, littleEndian);
      case "double":
        return dataView.getFloat64(0, littleEndian);
      default:
        console.warn("Unknown type:", type);
        return null;
    }
  }
}
