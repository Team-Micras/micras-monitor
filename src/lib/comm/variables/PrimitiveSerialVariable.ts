import { Access, TypeCode } from '../Protocol';
import { ISerializable } from '../ISerializable';
import { ISerialVariable, Fundamental } from './ISerialVariable';
import { defaultValue, readValue, typeName, writeValue } from '../TypeCodec';

/**
 * A variable the schema described by a type code, read and written straight out of a `DataView`.
 */
export class PrimitiveSerialVariable<T extends Fundamental> implements ISerialVariable {
  private valueRef: { value: T };

  constructor(
    private readonly name: string,
    private readonly type: TypeCode,
    private readonly access: Access,
    valueRef?: { value: T }
  ) {
    this.valueRef = valueRef ?? { value: defaultValue(type) as T };
  }

  getName(): string {
    return this.name;
  }

  getType(): string {
    return typeName(this.type);
  }

  getTypeCode(): TypeCode {
    return this.type;
  }

  getAccess(): Access {
    return this.access;
  }

  getReference(): { value: T } {
    return this.valueRef;
  }

  isReadOnly(): boolean {
    return !this.access.write;
  }

  serialize(): Uint8Array {
    return writeValue(this.valueRef.value, this.type);
  }

  deserialize(serialData: Uint8Array): void {
    const value = readValue(serialData, 0, this.type);

    if (value !== null) {
      this.valueRef.value = value as T;
    }
  }

  isEquals(other: ISerializable): boolean {
    return (
      other instanceof PrimitiveSerialVariable &&
      this.name === other.name &&
      this.valueRef.value === other.valueRef.value
    );
  }
}
