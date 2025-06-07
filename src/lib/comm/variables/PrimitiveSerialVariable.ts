import { ISerialVariable, Fundamental } from './ISerialVariable';
import { CppBinarySerializer, CppType } from '../CppSerializer';
import { ISerializable } from '../ISerializable';

/**
 * Class for serializing and deserializing primitive variables.
 *
 * @template T Type of the primitive variable.
 */
export class PrimitiveSerialVariable<T extends Fundamental> implements ISerialVariable {
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
  constructor(name: string, valueRef: { value: T }, readOnly: boolean, type: CppType) {
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
   * Get the variable's type.
   *
   * @returns Type of the variable as a string.
   */
  getType(): string {
    return this.type;
  }

  /**
   * Get a reference to the variable's value.
   *
   * @returns Reference object containing the variable's value.
   */
  getReference(): { value: T } {
    return this.valueRef;
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

  /**
   * Check if the variable is equal to another ISerializable.
   *
   * @param other Another ISerializable to compare with.
   * @returns True if the two variables are equal, false otherwise.
   */
  isEquals(other: ISerializable): boolean {
    if (!(other instanceof PrimitiveSerialVariable)) {
      return false;
    }
    return this.name === other.name && this.valueRef.value === other.valueRef.value;
  }
}
