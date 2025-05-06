import { ISerializable } from "../ISerializable";

export interface ISerialVariable extends ISerializable {
  /**
   * Get the name of the variable.
   *
   * @returns Name of the variable.
   */
  getName(): string;

  /**
   * Check if the variable is read-only.
   *
   * @returns True if the variable is read-only, false otherwise.
   */
  isReadOnly(): boolean;

  /**
   * Get the type of the variable.
   *
   * @returns Type of the variable as a string.
   */
  getType(): string;

  getReference(): { value: Fundamental | ISerializable };
}

/**
 * TypeScript equivalent of C++ concepts
 */
export type Fundamental = number | boolean | bigint | string;

/**
 * Type guard to check if a value is a primitive type.
 *
 * @param value The value to check.
 * @returns True if the value is a primitive type, false otherwise.
 */
export function isFundamental(value: any): value is Fundamental {
  return (
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "string"
  );
}

/**
 * Check if a value is serializable
 */
export function isSerializable(value: any): value is ISerializable {
  return (
    value &&
    typeof value.serialize === "function" &&
    typeof value.deserialize === "function"
  );
}
