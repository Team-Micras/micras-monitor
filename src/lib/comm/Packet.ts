export enum MessageType {
  PING = 0x00,
  PONG = 0x01,
  SERIAL_VARIABLE_MAP_REQUEST = 0x02,
  SERIAL_VARIABLE_MAP_RESPONSE = 0x03,
  SERIAL_VARIABLE = 0x04,
  DEBUG_LOG = 0x05,
  ERROR = 0x06,
  SERIAL_VARIABLE_CONTROL = 0x07,
}

export class Packet {
  static readonly HEADER_BYTE = 0x42;
  static readonly TAIL_BYTE = 0x7f;
  static readonly ESCAPE_BYTE = 0x7d;
  static readonly MINIMUM_SIZE = 7;

  private type: MessageType;
  private id: number;
  private payload: Uint8Array;

  /**
   * Creates a new Packet instance.
   *
   * @param type The type of the packet.
   * @param id The ID of the packet, default is 0.
   * @param payload The payload of the packet, default is an empty Uint8Array.
   */
  constructor(
    type: MessageType,
    id: number = 0,
    payload: Uint8Array = new Uint8Array([0])
  ) {
    this.type = type;
    this.id = id;
    this.payload = payload;
  }

  /**
   * Creates a Packet instance from a serialized packet.
   *
   * @param serializedPacket The serialized packet as a Uint8Array.
   * @returns A new Packet instance.
   */
  static fromSerialized(serializedPacket: Uint8Array): Packet {
    if (!Packet.isValid(serializedPacket)) {
      console.error(
        "Trying to deserialize an invalid packet:",
        serializedPacket
      );
      return new Packet(MessageType.ERROR);
    }

    const type = serializedPacket[1] as MessageType;
    const id = (serializedPacket[2] << 8) | serializedPacket[3];
    const escapedPayload = serializedPacket.slice(
      6,
      serializedPacket.length - 2
    );
    const payload = Packet.unescapePayload(escapedPayload);
    return new Packet(type, id, payload);
  }

  /**
   * Serializes the Packet instance to a Uint8Array.
   *
   * @returns The serialized packet as a Uint8Array.
   */
  serialize(): Uint8Array {
    const data: number[] = [];

    data.push(Packet.HEADER_BYTE);

    data.push(this.type);

    data.push((this.id >> 8) & 0xff);
    data.push(this.id & 0xff);

    data.push((this.payload.length >> 8) & 0xff);
    data.push(this.payload.length & 0xff);

    const escapedPayload = Packet.escapePayload(this.payload);
    data.push(...escapedPayload);

    let checksum = 0;
    for (let i = 1; i < data.length; i++) {
      checksum += data[i];
    }
    checksum %= 256;
    if (
      checksum === Packet.HEADER_BYTE ||
      checksum === Packet.TAIL_BYTE ||
      checksum === Packet.ESCAPE_BYTE
    ) {
      checksum += 1;
    }

    data.push(checksum);

    data.push(Packet.TAIL_BYTE);

    return new Uint8Array(data);
  }

  /**
   * Escapes the payload by adding escape bytes before special characters.
   *
   * @param payload The payload to escape.
   * @returns The escaped payload as a Uint8Array.
   */
  private static escapePayload(payload: Uint8Array): Uint8Array {
    const escaped: number[] = [];

    for (const byte of payload) {
      if (
        byte === Packet.HEADER_BYTE ||
        byte === Packet.TAIL_BYTE ||
        byte === Packet.ESCAPE_BYTE
      ) {
        escaped.push(Packet.ESCAPE_BYTE);
      }
      escaped.push(byte);
    }

    return new Uint8Array(escaped);
  }

  /**
   * Unescapes the payload by removing escape bytes before special characters.
   *
   * @param escapedPayload The escaped payload to unescape.
   * @returns The unescaped payload as a Uint8Array.
   */
  private static unescapePayload(escapedPayload: Uint8Array): Uint8Array {
    const payload: number[] = [];

    for (let i = 0; i < escapedPayload.length; i++) {
      if (escapedPayload[i] === Packet.ESCAPE_BYTE) {
        if (i + 1 < escapedPayload.length) {
          payload.push(escapedPayload[i + 1]);
          i++;
        }
      } else {
        payload.push(escapedPayload[i]);
      }
    }
    return new Uint8Array(payload);
  }

  /**
   * Validates the serialized packet.
   *
   * @param serializedPacket The serialized packet as a Uint8Array.
   * @returns True if the packet is valid, false otherwise.
   */
  static isValid(serializedPacket: Uint8Array): boolean {
    if (serializedPacket.length < Packet.MINIMUM_SIZE) {
      return false;
    }

    if (
      serializedPacket[0] !== Packet.HEADER_BYTE ||
      serializedPacket[serializedPacket.length - 1] !== Packet.TAIL_BYTE
    ) {
      return false;
    }

    let checksum = 0;
    for (let i = 1; i < serializedPacket.length - 2; i++) {
      checksum += serializedPacket[i];
    }
    checksum %= 256;

    if (
      checksum === Packet.HEADER_BYTE ||
      checksum === Packet.TAIL_BYTE ||
      checksum === Packet.ESCAPE_BYTE
    ) {
      checksum += 1;
    }

    return checksum === serializedPacket[serializedPacket.length - 2];
  }

  /**
   * Gets the type of the packet.
   *
   * @returns The type of the packet as a MessageType.
   */
  getType(): MessageType {
    return this.type;
  }

  /**
   * Gets the ID of the packet.
   *
   * @returns The ID of the packet as a number.
   */
  getId(): number {
    return this.id;
  }

  /**
   * Gets the payload of the packet.
   *
   * @returns The payload of the packet as a Uint8Array.
   */
  getPayload(): Uint8Array {
    return this.payload;
  }
}
