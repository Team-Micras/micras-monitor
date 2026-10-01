/**
 * The part of Web Bluetooth the transport uses.
 *
 * TypeScript's DOM library does not describe Web Bluetooth, and these few structural types are
 * all the transport needs, so they stand in for a dependency and are what the tests fake.
 *
 * @module
 */

/** `navigator.bluetooth`. */
export interface BluetoothLike {
  requestDevice(options: {
    filters: { services: string[] }[];
    optionalServices?: string[];
  }): Promise<BluetoothDeviceLike>;
}

/** A `BluetoothDevice`. */
export interface BluetoothDeviceLike {
  readonly id: string;
  readonly name?: string;
  readonly gatt?: GattServerLike;
  addEventListener(type: 'gattserverdisconnected', listener: () => void): void;
  removeEventListener(type: 'gattserverdisconnected', listener: () => void): void;
}

/** A `BluetoothRemoteGATTServer`. */
export interface GattServerLike {
  readonly connected: boolean;
  connect(): Promise<GattServerLike>;
  disconnect(): void;
  getPrimaryService(uuid: string): Promise<GattServiceLike>;
}

/** A `BluetoothRemoteGATTService`. */
export interface GattServiceLike {
  getCharacteristic(uuid: string): Promise<GattCharacteristicLike>;
}

/** A `BluetoothRemoteGATTCharacteristic`. */
export interface GattCharacteristicLike {
  /** The last value notified, a view that may start anywhere inside a larger buffer. */
  readonly value?: DataView | null;
  startNotifications(): Promise<unknown>;
  stopNotifications(): Promise<unknown>;
  writeValueWithoutResponse(value: Uint8Array): Promise<void>;
  addEventListener(type: 'characteristicvaluechanged', listener: () => void): void;
  removeEventListener(type: 'characteristicvaluechanged', listener: () => void): void;
}

/** Where a UART over BLE lives in the GATT table. */
export interface UartService {
  service: string;
  characteristic: string;
}

/**
 * The HM-19's transparent UART: one characteristic that notifies what the robot sends and takes
 * writes without response for what it receives.
 */
export const HM19_UART: UartService = {
  service: '0000ffe0-0000-1000-8000-00805f9b34fb',
  characteristic: '0000ffe1-0000-1000-8000-00805f9b34fb',
};

/**
 * What fits in one write without response at the default ATT MTU of 23 bytes, which is what the
 * HM-19 negotiates. Web Bluetooth does not expose the MTU, so it is configured, not discovered.
 */
export const DEFAULT_CHUNK_SIZE = 20;
