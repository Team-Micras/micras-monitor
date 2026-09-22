import { ISerialVariable } from './ISerialVariable';
import { ISerializable } from '../ISerializable';
import { Access, TypeCode } from '../Protocol';

/**
 * Class for serializing and deserializing custom variables.
 *
 * @template T Type of the custom variable.
 */
export class CustomSerialVariable<T extends ISerializable> implements ISerialVariable {
  private valueRef: { value: T };
  private name: string;
  private access: Access;

  /**
   * Constructor for the CustomSerialVariable class.
   *
   * @param name Name of the variable.
   * @param valueRef Reference object containing the value.
   * @param access What the link is allowed to do with the variable.
   */
  constructor(name: string, valueRef: { value: T }, access: Access) {
    this.valueRef = valueRef;
    this.name = name;
    this.access = access;
  }

  /**
   * Get the type of the variable as the schema states it.
   *
   * @returns Always a blob, which is what a class with its own encoding is on the wire.
   */
  getTypeCode(): TypeCode {
    return TypeCode.BLOB;
  }

  /**
   * Get what the link is allowed to do with the variable.
   *
   * @returns Access flags of the variable.
   */
  getAccess(): Access {
    return this.access;
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
    return this.valueRef.value.constructor.name;
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
    return !this.access.write;
  }

  /**
   * Serialize the variable.
   *
   * @returns Serialized data.
   */
  serialize(): Uint8Array {
    return this.valueRef.value.serialize();
  }

  /**
   * Deserialize the variable.
   *
   * @param serialData Pointer to the serialized data.
   */
  deserialize(serialData: Uint8Array): void {
    this.valueRef.value.deserialize(serialData);
  }

  /**
   * Check if the variable is equal to another ISerializable.
   *
   * @param other Another ISerializable to compare with.
   * @returns True if the two variables are equal, false otherwise.
   */
  isEquals(other: ISerializable): boolean {
    if (!(other instanceof CustomSerialVariable)) {
      return false;
    }
    return this.valueRef.value.isEquals(other.getReference().value);
  }
}
