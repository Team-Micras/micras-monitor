/**
 * Service for managing Bluetooth communication
 */
export class BluetoothService {
  private serviceUuid: string = "0000ffe0-0000-1000-8000-00805f9b34fb";
  private characteristicUuid: string = "0000ffe1-0000-1000-8000-00805f9b34fb";
  private receiveBuffer: Uint8Array[] = [];
  private sendBuffer: Uint8Array[] = [];
  private device: BluetoothDevice | null = null;
  private characteristic?: BluetoothRemoteGATTCharacteristic | null = null;
  private onConnectionChanged?: (connected: boolean) => void;
  private isConnected = false;

  /**
   * Creates a new BluetoothService instance
   *
   * @param onConnectionChanged - Optional callback for connection status changes
   */
  constructor(
    serviceUuid?: string,
    characteristicUuid?: string,
    onConnectionChanged?: (connected: boolean) => void
  ) {
    if (serviceUuid) {
      this.serviceUuid = serviceUuid;
    }
    if (characteristicUuid) {
      this.characteristicUuid = characteristicUuid;
    }
    this.onConnectionChanged = onConnectionChanged;
  }

  /**
   * Request connection to a Bluetooth device
   *
   * @returns Promise that resolves when connected to a device
   */
  async connect(): Promise<void> {
    try {
      if (!navigator.bluetooth) {
        throw new Error("Web Bluetooth API is not available on this browser");
      }

      this.device = await navigator.bluetooth.requestDevice({
        filters: [{ services: [this.serviceUuid] }],
      });

      this.device.addEventListener(
        "gattserverdisconnected",
        this.handleDisconnection.bind(this)
      );

      const server = await this.device.gatt?.connect();
      if (!server) {
        throw new Error("Failed to connect to GATT server");
      }
      console.log("Connected to GATT server");

      const service = await server.getPrimaryService(this.serviceUuid);

      this.characteristic = await service.getCharacteristic(
        this.characteristicUuid
      );

      this.characteristic.addEventListener(
        "characteristicvaluechanged",
        this.handleValueChanged.bind(this)
      );
      await this.characteristic.startNotifications();

      this.setConnectionStatus(true);
      console.log("Bluetooth device connected successfully");
    } catch (error) {
      this.setConnectionStatus(false);
      this.device = null;
      this.characteristic = null;
      console.error("Error connecting to Bluetooth device:", error);
      throw error;
    }
  }

  /**
   * Disconnect from the current Bluetooth device
   */
  async disconnect(): Promise<void> {
    if (!this.device) {
      console.warn("No Bluetooth device to disconnect from");
      return;
    }

    if (this.device.gatt?.connected) {
      if (this.characteristic) {
        await this.characteristic.stopNotifications();
        this.characteristic.removeEventListener(
          "characteristicvaluechanged",
          this.handleValueChanged.bind(this)
        );
      }

      this.device.gatt.disconnect();
      console.log("Bluetooth device disconnected");
    }

    this.setConnectionStatus(false);
    this.characteristic = null;
    this.device = null;
  }

  sendData(data: Uint8Array): void {
    if (!this.isConnected) {
      console.warn("Bluetooth device not connected");
      return;
    }

    this.sendBuffer.push(data);
  }

  getData(): Uint8Array {
    if (!this.isConnected) {
      console.warn("Bluetooth device not connected");
      return new Uint8Array(0);
    }

    const data = BluetoothService.flattenUint8Arrays(this.receiveBuffer);
    this.receiveBuffer = [];
    return data;
  }

  update(): void {
    this.processSendBuffer();
  }

  /**
   * Check if a Bluetooth device is currently connected
   *
   * @returns True if connected, false otherwise
   */
  isDeviceConnected(): boolean {
    return this.isConnected;
  }

  getDeviceName(): string {
    return this.device ? this.device.name || "Unknown Device" : "No Device";
  }

  /**
   * Handle disconnection event
   */
  private handleDisconnection(event: Event): void {
    const device = event.target as BluetoothDevice;
    console.log(
      `Bluetooth device "${device.name}" disconnected, attempting to reconnect...`
    );
    this.setConnectionStatus(false);
    this.device = null;
    this.characteristic = null;

    // @todo attempt reconnection logic here
  }

  /**
   * Handle value changed event for the RX characteristic
   *
   * @param event - The characteristic value changed event
   */
  private handleValueChanged(event: Event): void {
    const target = event.target as BluetoothRemoteGATTCharacteristic;
    const value = target.value as DataView;
    this.receiveBuffer.push(new Uint8Array(value.buffer));
  }

  private async processSendBuffer(): Promise<void> {
    if (!this.characteristic || !this.isConnected) {
      console.warn("Bluetooth device not connected");
      return Promise.resolve();
    }

    if (this.sendBuffer.length === 0) {
      console.warn("No data to send");
      return Promise.resolve();
    }

    const dataToSend = BluetoothService.flattenUint8Arrays(this.sendBuffer);
    const chunkSize = 20; // Maximum size for a single write operation

    for (let i = 0; i < dataToSend.length; i += chunkSize) {
      const chunk = dataToSend.slice(i, i + chunkSize);
      await this.characteristic?.writeValue(chunk);
    }

    this.sendBuffer = [];
    return Promise.resolve();
  }

  /**
   * Update the connection status and notify listeners
   *
   * @param status - The new connection status
   */
  private setConnectionStatus(status: boolean): void {
    if (this.isConnected !== status) {
      this.isConnected = status;

      console.log(
        `Bluetooth connection status changed: ${
          status ? "Connected" : "Disconnected"
        }`
      );

      if (this.onConnectionChanged) {
        this.onConnectionChanged(status);
      }
    }
  }

  private static flattenUint8Arrays(arrays: Uint8Array[]): Uint8Array {
    const totalLength = arrays.reduce((acc, arr) => acc + arr.byteLength, 0);
    const result = new Uint8Array(totalLength);

    let offset = 0;
    for (const array of arrays) {
      result.set(array, offset);
      offset += array.byteLength;
    }

    return result;
  }
}
