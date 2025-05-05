import { ISerialVariable, Fundamental } from "./ISerialVariable";
import { CppBinarySerializer, CppType } from "../CppSerializer";

/**
 * Class for serializing and deserializing primitive variables.
 *
 * @template T Type of the primitive variable.
 */
export class PrimitiveSerialVariable<T extends Fundamental>
  implements ISerialVariable
{
  private valueRef: { value: T };
  private name: string;
  private type: CppType;
  private readOnly: boolean;

  /**
   * Constructor for the PrimitiveSerialVariable class.
   *
   * @param name Name of the variable.
   * @param valueRef Reference object containing the value.
   * @param readOnly True if the variable is read-only, false otherwise.
   */
  constructor(
    name: string,
    valueRef: { value: T },
    readOnly: boolean,
    type: CppType
  ) {
    this.valueRef = valueRef;
    this.name = name;
    this.readOnly = readOnly;
    this.type = type;
  }

  /**
   * Get the variable's name.
   *
   * @returns Name of the variable.
   */
  getName(): string {
    return this.name;
  }

  /**
   * Check if the variable is read-only.
   *
   * @returns True if the variable is read-only, false otherwise.
   */
  isReadOnly(): boolean {
    return this.readOnly;
  }

  /**
   * Serialize the variable.
   *
   * @returns Serialized data.
   */
  serialize(): Uint8Array {
    return CppBinarySerializer.serializeValue(this.valueRef.value, this.type);
  }

  /**
   * Deserialize the variable.
   *
   * @param serialData Pointer to the serialized data.
   */
  deserialize(serialData: Uint8Array): void {
    const value = CppBinarySerializer.deserializeValue(serialData, this.type);
    if (value !== null) {
      this.valueRef.value = value as T;
    }
  }
}
