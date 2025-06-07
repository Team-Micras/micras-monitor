/**
 * Service for managing WebSocket communication with a simulated device
 */
export class WebSocketService {
  private url: string;
  private socket: WebSocket | null = null;
  private receiveBuffer: Uint8Array[] = [];
  private sendBuffer: Uint8Array[] = [];
  private onConnectionChanged?: (connected: boolean) => void;
  private isConnected = false;
  private sendBufferTask: number | null = null;
  private sendBufferInterval: number = 50;
  private isProcessingSendBuffer = false;
  private reconnectAttempts = 0;
  private readonly MAX_RECONNECT_ATTEMPTS = 5;
  private reconnectTimeout: number | null = null;
  private keepAlive: boolean = true;

  /**
   * Creates a new WebSocketService instance
   *
   * @param url - The WebSocket server URL
   * @param onConnectionChanged - Optional callback for connection status changes
   */
  constructor(url: string, onConnectionChanged?: (connected: boolean) => void) {
    this.url = url;
    this.onConnectionChanged = onConnectionChanged;
  }

  /**
   * Connect to the WebSocket server
   *
   * @returns Promise that resolves when connected to the server
   */
  async connect(): Promise<void> {
    if (this.socket) {
      // Already connected or connecting
      return;
    }

    try {
      return new Promise<void>((resolve, reject) => {
        this.socket = new WebSocket(this.url);

        this.socket.binaryType = 'arraybuffer';

        this.socket.onopen = () => {
          console.log('WebSocket connection established');
          this.setConnectionStatus(true);
          this.keepAlive = true;
          this.reconnectAttempts = 0;
          this.startSendBufferTask();
          resolve();
        };

        this.socket.onclose = () => {
          console.log('WebSocket connection closed');
          this.handleDisconnection();
        };

        this.socket.onerror = (error) => {
          console.error('WebSocket error:', error);
          reject(new Error('Failed to connect to WebSocket server'));
        };

        this.socket.onmessage = (event) => {
          if (event.data instanceof ArrayBuffer) {
            this.receiveBuffer.push(new Uint8Array(event.data));
          } else {
            console.warn('Received non-binary data:', event.data);
          }
        };
      });
    } catch (error) {
      this.setConnectionStatus(false);
      this.socket = null;
      console.error('Error connecting to WebSocket server:', error);
      throw error;
    }
  }

  /**
   * Disconnect from the WebSocket server
   */
  async disconnect(): Promise<void> {
    if (!this.socket) {
      console.warn('No WebSocket connection to disconnect from');
      return;
    }
    this.keepAlive = false;

    // Clear any pending reconnect timeout
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }

    this.stopSendBufferTask();
    this.setConnectionStatus(false);

    // Close the connection
    if (this.socket.readyState === WebSocket.OPEN) {
      this.socket.close();
    }

    this.socket = null;
    this.receiveBuffer = [];
  }

  /**
   * Send data to the connected WebSocket server
   *
   * @param data - The data to send
   */
  sendData(data: Uint8Array): void {
    if (!this.isConnected) {
      console.warn('WebSocket not connected');
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
      console.warn('WebSocket not connected');
      return new Uint8Array(0);
    }

    const data = WebSocketService.flattenUint8Arrays(this.receiveBuffer);
    this.receiveBuffer = [];
    return data;
  }

  /**
   * Check if a WebSocket connection is currently established
   *
   * @returns True if connected, false otherwise
   */
  isDeviceConnected(): boolean {
    return this.isConnected;
  }

  /**
   * Get the URL of the connected WebSocket server
   *
   * @returns URL of the WebSocket server
   */
  getServerUrl(): string {
    return this.url;
  }

  /**
   * Handle disconnection event
   */
  private handleDisconnection(): void {
    this.setConnectionStatus(false);
    this.stopSendBufferTask();

    if (this.keepAlive) {
      console.log('WebSocket disconnected, attempting to reconnect...');
      this.attemptReconnection();
    }
  }

  /**
   * Attempt to reconnect to the WebSocket server with exponential backoff
   */
  private attemptReconnection(): void {
    //@TODO tirar isso
    if (this.reconnectAttempts < this.MAX_RECONNECT_ATTEMPTS) {
      this.reconnectAttempts++;
      const delay = Math.pow(2, this.reconnectAttempts) * 1000;

      console.log(
        `Reconnection attempt ${this.reconnectAttempts}/${
          this.MAX_RECONNECT_ATTEMPTS
        } in ${delay / 1000} seconds`
      );

      this.reconnectTimeout = window.setTimeout(async () => {
        try {
          await this.connect();
          console.log('WebSocket reconnected successfully');
        } catch (error) {
          console.error(`Reconnection attempt ${this.reconnectAttempts} failed:`, error);
          this.attemptReconnection();
        }
      }, delay);
    } else {
      console.error('Maximum WebSocket reconnection attempts reached');
      this.reconnectAttempts = 0;
    }
  }

  /**
   * Process the send buffer by sending data to the WebSocket server
   *
   * @returns Promise that resolves when buffer processing is complete
   */
  private async processSendBuffer(): Promise<void> {
    if (
      !this.socket ||
      !this.isConnected ||
      this.isProcessingSendBuffer ||
      this.sendBuffer.length === 0 ||
      this.socket.readyState !== WebSocket.OPEN
    ) {
      return Promise.resolve();
    }

    this.isProcessingSendBuffer = true;

    try {
      const dataToSend = WebSocketService.flattenUint8Arrays(this.sendBuffer);
      this.sendBuffer = [];

      if (dataToSend.length > 0) {
        this.socket.send(dataToSend.buffer);
      }
    } catch (error) {
      console.error('Error sending data via WebSocket:', error);
    } finally {
      this.isProcessingSendBuffer = false;
    }

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
        `WebSocket connection status changed: ${status ? 'Connected' : 'Disconnected'}`
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
