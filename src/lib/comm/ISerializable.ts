export interface ISerializable {
  /**
   * Serialize the class instance.
   *
   * @returns Serialized data.
   */
  serialize(): Uint8Array;

  /**
   * Deserialize the class instance.
   *
   * @param serialData Serialized data.
   */
  deserialize(serialData: Uint8Array): void;

  /**
   * Check if the variable is equal to another ISerializable.
   *
   * @param other Another ISerializable to compare with.
   * @returns True if the two variables are equal, false otherwise.
   */
  isEquals(other: ISerializable): boolean;
}
