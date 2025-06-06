import { ISerialVariable } from './ISerialVariable';
import { ISerializable } from '../ISerializable';

/**
 * Class for serializing and deserializing custom variables.
 *
 * @template T Type of the custom variable.
 */
export class CustomSerialVariable<T extends ISerializable> implements ISerialVariable {
  private valueRef: { value: T };
  private name: string;
  private readOnly: boolean;

  /**
   * Constructor for the CustomSerialVariable class.
   *
   * @param name Name of the variable.
   * @param valueRef Reference object containing the value.
   * @param readOnly True if the variable is read-only, false otherwise.
   */
  constructor(name: string, valueRef: { value: T }, readOnly: boolean) {
    this.valueRef = valueRef;
    this.name = name;
    this.readOnly = readOnly;
  }

  /**
   * Get the variable's name.
   *
   * @returns Name of the variable.
   */
  getName(): string {
    return this.name;
  }

  getType(): string {
    return this.valueRef.value.constructor.name;
  }

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
}
