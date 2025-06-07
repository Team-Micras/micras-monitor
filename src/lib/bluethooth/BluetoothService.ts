/**
 * Service for managing Bluetooth communication
 */
export class BluetoothService {
  private serviceUuid: string = '0000ffe0-0000-1000-8000-00805f9b34fb';
  private characteristicUuid: string = '0000ffe1-0000-1000-8000-00805f9b34fb';
  private receiveBuffer: Uint8Array[] = [];
  private sendBuffer: Uint8Array[] = [];
  private device: BluetoothDevice | null = null;
  private characteristic: BluetoothRemoteGATTCharacteristic | null = null;
  private onConnectionChanged?: (connected: boolean) => void;
  private isConnected = false;
  private sendBufferTask: number | null = null;
  private sendBufferInterval: number = 50;
  private readonly CONNECTION_TIMEOUT = 10000000;
  private readonly MAX_RETRY_ATTEMPTS = 3;
  private retryCount = 0;
  private isProcessingSendBuffer = false;
  private keepAlive: boolean = true;

  /**
   * Creates a new BluetoothService instance
   *
   * @param serviceUuid - Optional custom service UUID
   * @param characteristicUuid - Optional custom characteristic UUID
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
        throw new Error('Web Bluetooth API is not available on this browser');
      }

      this.device = await navigator.bluetooth.requestDevice({
        filters: [{ services: [this.serviceUuid] }],
      });

      this.device.addEventListener(
        'gattserverdisconnected',
        this.handleDisconnection.bind(this)
      );

      const connectionPromise = this.connectToDevice();
      const timeoutPromise = new Promise<void>((_, reject) => {
        setTimeout(
          () => reject(new Error('Connection timeout exceeded')),
          this.CONNECTION_TIMEOUT
        );
      });

      await Promise.race([connectionPromise, timeoutPromise]);
    } catch (error) {
      this.setConnectionStatus(false);
      this.device = null;
      this.characteristic = null;
      console.error('Error connecting to Bluetooth device:', error);
      throw error;
    }
  }

  /**
   * Internal method to handle the device connection process
   */
  private async connectToDevice(): Promise<void> {
    await this.setupConnection();
    console.log('Bluetooth device connected successfully');
  }

  /**
   * Common logic for connecting to a device and setting up the characteristic
   * @returns Promise that resolves when the connection process completes
   */
  private async setupConnection(): Promise<void> {
    if (!this.device || !this.device.gatt) {
      throw new Error('No Bluetooth device available');
    }

    const server = await this.device.gatt.connect();
    if (!server) {
      throw new Error('Failed to connect to GATT server');
    }
    console.log('Connected to GATT server');

    const service = await server.getPrimaryService(this.serviceUuid);

    this.characteristic = await service.getCharacteristic(this.characteristicUuid);

    this.characteristic.addEventListener(
      'characteristicvaluechanged',
      this.handleValueChanged.bind(this)
    );
    await this.characteristic.startNotifications();

    this.keepAlive = true;
    this.setConnectionStatus(true);
    this.startSendBufferTask();
  }

  /**
   * Disconnect from the current Bluetooth device
   */
  async disconnect(): Promise<void> {
    if (!this.device) {
      console.warn('No Bluetooth device to disconnect from');
      return;
    }

    if (this.device.gatt?.connected) {
      if (this.characteristic) {
        await this.characteristic.stopNotifications();
        this.characteristic.removeEventListener(
          'characteristicvaluechanged',
          this.handleValueChanged.bind(this)
        );
      }

      this.device.gatt.disconnect();
      console.log('Bluetooth device disconnected');
    }

    this.keepAlive = false;
    this.setConnectionStatus(false);
    this.stopSendBufferTask();
    this.characteristic = null;
    this.device = null;
  }

  /**
   * Send data to the connected Bluetooth device
   *
   * @param data - The data to send
   */
  sendData(data: Uint8Array): void {
    if (!this.isConnected) {
      console.warn('Bluetooth device not connected');
      return;
    }

    this.sendBuffer.push(data);
  }

  /**
   * Get and clear all received data from the buffer
   *
   * @returns Concatenated array of all received data
   */
  getData(): Uint8Array {
    if (!this.isConnected) {
      console.warn('Bluetooth device not connected');
      return new Uint8Array(0);
    }

    const data = BluetoothService.flattenUint8Arrays(this.receiveBuffer);
    this.receiveBuffer = [];
    return data;
  }

  /**
   * Check if a Bluetooth device is currently connected
   *
   * @returns True if connected, false otherwise
   */
  isDeviceConnected(): boolean {
    return this.isConnected;
  }

  /**
   * Get the name of the currently connected device
   *
   * @returns Name of the connected device or default message if no device
   */
  getDeviceName(): string {
    return this.device ? this.device.name || 'Unknown Device' : 'No Device';
  }

  /**
   * Handle disconnection event
   */
  private handleDisconnection(event: Event): void {
    const device = event.target as BluetoothDevice;
    this.setConnectionStatus(false);
    this.stopSendBufferTask();

    if (this.keepAlive) {
      console.log(
        `Bluetooth device "${device.name}" disconnected, attempting to reconnect...`
      );
      this.attemptReconnection();
    }
  }

  /**
   * Attempt to reconnect to the device with exponential backoff
   */
  private attemptReconnection(): void {
    if (this.retryCount < this.MAX_RETRY_ATTEMPTS) {
      this.retryCount++;
      console.log(`Reconnection attempt ${this.retryCount}/${this.MAX_RETRY_ATTEMPTS}`);

      const delay = Math.pow(2, this.retryCount) * 1000;

      setTimeout(async () => {
        if (this.device && this.device.gatt) {
          try {
            await this.setupConnection();
            this.retryCount = 0;
            console.log('Bluetooth device reconnected successfully');
          } catch (error) {
            console.error(`Reconnection attempt ${this.retryCount} failed:`, error);
            this.attemptReconnection();
          }
        } else {
          this.device = null;
          this.characteristic = null;
          console.error('Device is no longer available for reconnection');
        }
      }, delay);
    } else {
      console.error('Maximum reconnection attempts reached');
      this.device = null;
      this.characteristic = null;
      this.retryCount = 0;
    }
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

  /**
   * Process the send buffer by sending data to the Bluetooth device
   *
   * @returns Promise that resolves when buffer processing is complete
   */
  private async processSendBuffer(): Promise<void> {
    if (
      !this.characteristic ||
      !this.isConnected ||
      this.isProcessingSendBuffer ||
      this.sendBuffer.length === 0
    ) {
      return Promise.resolve();
    }

    this.isProcessingSendBuffer = true;

    try {
      const dataToSend = BluetoothService.flattenUint8Arrays(this.sendBuffer);
      const chunkSize = 20;
      this.sendBuffer = [];

      if (dataToSend.length > 0) {
        const chunks: Uint8Array[] = [];
        for (let i = 0; i < dataToSend.length; i += chunkSize) {
          chunks.push(dataToSend.slice(i, i + chunkSize));
        }

        let writePromise = this.writeChunk(chunks[0]);
        for (let i = 1; i < chunks.length; i++) {
          writePromise = writePromise.then(() => this.writeChunk(chunks[i]));
        }

        await writePromise;
        console.debug(`Sent ${dataToSend.length} bytes via Bluetooth`);
      }
    } catch (error) {
      console.error('Error sending data via Bluetooth:', error);
    } finally {
      this.isProcessingSendBuffer = false;
    }

    return Promise.resolve();
  }

  /**
   * Write a single chunk to the characteristic
   * @param chunk - Data chunk to write
   * @returns Promise that resolves when writing is complete
   */
  private async writeChunk(chunk: Uint8Array): Promise<void> {
    if (!this.characteristic) {
      throw new Error('No characteristic available');
    }
    return this.characteristic.writeValue(chunk);
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
        `Bluetooth connection status changed: ${status ? 'Connected' : 'Disconnected'}`
      );

      if (this.onConnectionChanged) {
        this.onConnectionChanged(status);
      }
    }
  }

  /**
   * Start the task that periodically processes the send buffer
   */
  private startSendBufferTask(): void {
    if (this.sendBufferTask === null) {
      this.sendBufferTask = window.setInterval(
        this.processSendBuffer.bind(this),
        this.sendBufferInterval
      );
    }
  }

  /**
   * Stop the send buffer processing task
   */
  private stopSendBufferTask(): void {
    if (this.sendBufferTask !== null) {
      clearInterval(this.sendBufferTask);
      this.sendBufferTask = null;
    }
  }

  /**
   * Utility method to combine multiple Uint8Arrays into a single array
   *
   * @param arrays - Array of Uint8Arrays to flatten
   * @returns Single Uint8Array containing all input data
   */
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
