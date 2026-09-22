import { ISerializable } from '../ISerializable';
import { Access, TypeCode } from '../Protocol';

export interface ISerialVariable extends ISerializable {
  /**
   * Get the name of the variable.
   *
   * @returns Name of the variable.
   */
  getName(): string;

  /**
   * Check if the variable can be written from here.
   *
   * @note A variable can be writable and still refuse a write while the robot is moving, which is
   * what the idle flag says and what the acknowledgement of the write reports.
   *
   * @returns True if the variable is read-only, false otherwise.
   */
  isReadOnly(): boolean;

  /**
   * Get the type of the variable, for display.
   *
   * @returns Type of the variable as a string.
   */
  getType(): string;

  /**
   * Get the type of the variable as the schema states it.
   *
   * @returns Type code of the variable.
   */
  getTypeCode(): TypeCode;

  /**
   * Get what the link is allowed to do with the variable.
   *
   * @returns Access flags of the variable.
   */
  getAccess(): Access;

  /**
   * Get a reference to the variable's value.
   *
   * @returns Reference object containing the value.
   */
  getReference(): { value: Fundamental | ISerializable };
}

/**
 * TypeScript equivalent of C++ primitive types.
 */
export type Fundamental = number | boolean | bigint | string;

/**
 * Type guard to check if a value is a primitive type.
 *
 * @param value The value to check.
 * @returns True if the value is a primitive type, false otherwise.
 */
export function isFundamental(value: unknown): value is Fundamental {
  return (
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'string' ||
    typeof value === 'bigint'
  );
}

/**
 * Check if a value is serializable
 */
export function isSerializable(value: unknown): value is ISerializable {
  return (
    value !== null &&
    typeof value === 'object' &&
    'serialize' in value &&
    'deserialize' in value &&
    typeof (value as Record<string, unknown>).serialize === 'function' &&
    typeof (value as Record<string, unknown>).deserialize === 'function'
  );
}
