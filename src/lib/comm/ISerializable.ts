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
}
