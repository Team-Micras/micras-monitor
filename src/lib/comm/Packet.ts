export class Packet {
  static readonly HEADER_BYTE = 0x42;
  static readonly TAIL_BYTE = 0x7f;
  static readonly ESCAPE_BYTE = 0x7d;
  static readonly MINIMUM_SIZE = 7;

  private type: Packet.MessageType;
  private id: number;
  private payload: Uint8Array;

  constructor(
    type: Packet.MessageType,
    id: number = 0,
    payload: Uint8Array = new Uint8Array([0])
  ) {
    this.type = type;
    this.id = id;
    this.payload = payload;
  }

  static fromSerialized(serializedPacket: Uint8Array): Packet {
    if (!Packet.isValid(serializedPacket)) {
      console.error("Trying to deserialize an invalid packet");
      return new Packet(Packet.MessageType.ERROR);
    }

    const id = (serializedPacket[1] << 8) | serializedPacket[2];
    const type = serializedPacket[3] as Packet.MessageType;
    const escapedPayload = serializedPacket.slice(
      6,
      serializedPacket.length - 2
    );
    const payload = Packet.unescapePayload(escapedPayload);
    return new Packet(type, id, payload);
  }

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
    data.push(checksum);

    data.push(Packet.TAIL_BYTE);

    return new Uint8Array(data);
  }

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

    return checksum === serializedPacket[serializedPacket.length - 2];
  }

  getType(): Packet.MessageType {
    return this.type;
  }

  getId(): number {
    return this.id;
  }

  getPayload(): Uint8Array {
    return this.payload;
  }
}

export namespace Packet {
  export enum MessageType {
    PING = 0x00,
    PONG = 0x01,
    SERIAL_VARIABLE_MAP_REQUEST = 0x02,
    SERIAL_VARIABLE_MAP_RESPONSE = 0x03,
    SERIAL_VARIABLE = 0x04,
    DEBUG_LOG = 0x05,
    ERROR = 0x06,
  }
}
