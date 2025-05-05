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
   * @param size Size of the serialized data.
   */
  deserialize(serialData: Uint8Array, size: number): void;
}
