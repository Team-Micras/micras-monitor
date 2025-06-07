import { Packet, MessageType } from './Packet';
import { SerialVariablePool } from './SerialVariablePool';
import { ISerialVariable } from './variables/ISerialVariable';

/**
 * Type definitions for communication functions.
 */
export type SendDataFunction = (data: Uint8Array) => Promise<void>;
export type GetDataFunction = () => Promise<Uint8Array>;

/**
 * Class for controlling the communication service.
 */
export class CommunicationService {
  private pool: SerialVariablePool;
  private sendDataFunc?: SendDataFunction;
  private getDataFunc?: GetDataFunction;
  private functionsRegistered: boolean = false;
  private incomingDataQueue: number[] = [];
  private incomingPackets: Packet[] = [];
  private isConnected: boolean = false;
  private receiveDataTask?: number;
  private verifyConnectionTask?: number;
  private onConnectionStatusChange?: (status: boolean) => void;
  private pongReceived: boolean = false;
  private connectionCheckTimeouts: number[] = [];

  /**
   * Creates a new CommunicationService instance.
   *
   * @param pool - The serial variable pool to manage variables.
   * @param onConnectionStatusChange - Optional callback for connection status changes.
   */
  constructor(
    pool: SerialVariablePool,
    onConnectionStatusChange?: (status: boolean) => void
  ) {
    this.pool = pool;
    this.onConnectionStatusChange = onConnectionStatusChange;

    this.pool.addVariableChangeListener((id, variable) => {
      this.sendVariable(id, variable);
    });
  }

  /**
   * Registers the communication functions for sending and receiving data.
   *
   * @param sendFunc - Function for sending data.
   * @param getFunc - Function for receiving data.
   */
  registerCommunicationFunctions(
    sendFunc: SendDataFunction,
    getFunc: GetDataFunction
  ): void {
    this.sendDataFunc = sendFunc;
    this.getDataFunc = getFunc;
    this.functionsRegistered = true;
  }

  /**
   * Starts the periodic update and connection verification tasks.
   *
   * @param interval - The update interval in milliseconds.
   */
  startCommunication(interval: number = 50): void {
    console.log('Starting communication');

    if (this.receiveDataTask !== undefined) {
      clearInterval(this.receiveDataTask);
      this.receiveDataTask = undefined;
    }

    this.stopConnectionVerification();

    this.receiveDataTask = window.setInterval(() => {
      this.update();
    }, interval);

    this.startConnectionVerification();
  }

  /**
   * Stops all periodic tasks.
   */
  stopCommunication(): void {
    console.log('Stopping communication');

    this.setConnectionStatus(false);
    this.incomingDataQueue = [];
    this.incomingPackets = [];

    if (this.receiveDataTask !== undefined) {
      clearInterval(this.receiveDataTask);
      this.receiveDataTask = undefined;
    }

    this.stopConnectionVerification();
  }

  /**
   * Returns whether the service is currently connected to a remote device.
   */
  isServiceConnected(): boolean {
    return this.isConnected;
  }

  /**
   * Enable or disable the transmition of the varible from the remote device.
   *
   * @param id - Id of the fariable to be enabled/disabled.
   * @param enabled - The status to set the variable.
   */
  setVariableEnabled(id: number, enabled: boolean): void {
    const control = enabled ? 1 : 0;
    console.debug(
      `Sending SERIAL_VARIABLE_CONTROL: ${
        enabled ? 'enabling' : 'disabling'
      } variable ${id}`
    );
    this.sendPacket(
      new Packet(MessageType.SERIAL_VARIABLE_CONTROL, id, new Uint8Array([control]))
    );
  }

  /**
   * Updates the communication service by processing incoming packets.
   */
  private async update(): Promise<void> {
    if (!this.functionsRegistered) {
      console.warn('Communication functions not registered');
      return;
    }

    await this.updateIncomingPackets();
    this.processIncomingPackets();
  }

  /**
   * Starts the connection verification task that sends pings periodically
   * to check if the connection is still active.
   *
   * @param interval - The verification interval in milliseconds.
   */
  private startConnectionVerification(interval: number = 2000): void {
    this.stopConnectionVerification();

    this.verifyConnectionTask = window.setInterval(() => {
      this.pongReceived = false;
      this.ping();

      if (!this.isConnected) {
        const timeoutId = window.setTimeout(() => {
          if (this.pongReceived) {
            this.setConnectionStatus(true);
            this.requestVariableMap();
          }
          this.clearConnectionCheckTimeout(timeoutId);
        }, 1000);
        this.connectionCheckTimeouts.push(timeoutId);
      } else {
        const timeoutId = window.setTimeout(() => {
          if (!this.pongReceived) {
            this.setConnectionStatus(false);
          }
          this.clearConnectionCheckTimeout(timeoutId);
        }, 1000);
        this.connectionCheckTimeouts.push(timeoutId);
      }
    }, interval);
  }

  /**
   * Clears a connection check timeout and removes it from the list.
   *
   * @param timeoutId - The ID of the timeout to clear.
   */
  private clearConnectionCheckTimeout(timeoutId: number): void {
    const index = this.connectionCheckTimeouts.indexOf(timeoutId);
    if (index !== -1) {
      this.connectionCheckTimeouts.splice(index, 1);
    }
  }

  /**
   * Stops the connection verification task and clears any pending timeouts.
   */
  private stopConnectionVerification(): void {
    if (this.verifyConnectionTask !== undefined) {
      clearInterval(this.verifyConnectionTask);
      this.verifyConnectionTask = undefined;
    }

    this.connectionCheckTimeouts.forEach((timeoutId) => {
      clearTimeout(timeoutId);
    });
    this.connectionCheckTimeouts = [];
  }

  /**
   * Sends a ping packet to the remote device.
   */
  private ping(): void {
    console.log('Sending PING');
    this.sendPacket(new Packet(MessageType.PING));
  }

  /**
   * Requests the variable map from the remote device.
   */
  private requestVariableMap(): void {
    console.log('Sending SERIAL_VARIABLE_MAP_REQUEST');
    this.sendPacket(new Packet(MessageType.SERIAL_VARIABLE_MAP_REQUEST));
  }

  /**
   * Sends a variable update to the remote device.
   *
   * @param id - The ID of the variable.
   * @param variable - The variable to send.
   */
  private sendVariable(id: number, variable: ISerialVariable): void {
    this.sendPacket(new Packet(MessageType.SERIAL_VARIABLE, id, variable.serialize()));
  }

  /**
   * Updates the connection status and notifies listeners if it has changed.
   *
   * @param status - The new connection status.
   */
  private setConnectionStatus(status: boolean): void {
    console.log(`Connection status changed: ${status ? 'Connected' : 'Disconnected'}`);
    if (this.isConnected !== status) {
      this.isConnected = status;

      if (this.onConnectionStatusChange) {
        this.onConnectionStatusChange(status);
      }
    }
  }

  /**
   * Updates the incoming packets queue by fetching data from the source.
   */
  private async updateIncomingPackets(): Promise<void> {
    if (!this.getDataFunc) {
      return;
    }

    try {
      const data = await this.getDataFunc();

      for (let i = 0; i < data.length; i++) {
        this.incomingDataQueue.push(data[i]);

        if (this.hasValidPacketTail()) {
          const packetData = this.extractValidPacket();
          this.incomingPackets.push(Packet.fromSerialized(packetData));
          this.incomingDataQueue = [];
        }
      }
    } catch (error) {
      console.error('Error updating incoming packets:', error);
    }
  }

  /**
   * Checks if the incoming data queue has a valid packet tail.
   *
   * @returns true if the queue has a valid packet tail, false otherwise.
   */
  private hasValidPacketTail(): boolean {
    const queue = this.incomingDataQueue;

    if (queue.length < Packet.MINIMUM_SIZE) {
      return false;
    }

    return (
      queue[queue.length - 2] !== Packet.ESCAPE_BYTE &&
      queue[queue.length - 1] === Packet.TAIL_BYTE
    );
  }

  /**
   * Extracts a valid packet from the incoming data queue.
   *
   * @returns A Uint8Array containing the valid packet data.
   */
  private extractValidPacket(): Uint8Array {
    const queue = this.incomingDataQueue;
    let startIndex = 0;

    while (startIndex < queue.length && queue[startIndex] !== Packet.HEADER_BYTE) {
      if (queue[startIndex] === Packet.ESCAPE_BYTE) {
        startIndex++;
      }

      startIndex++;
    }

    return new Uint8Array(queue.slice(startIndex));
  }

  /**
   * Processes all incoming packets and consumes them.
   */
  private processIncomingPackets(): void {
    while (this.incomingPackets.length > 0) {
      const packet = this.incomingPackets.shift()!;
      this.consumePacket(packet);
    }
  }

  /**
   * Sends a packet to the remote device.
   *
   * @param packet - The packet to send.
   * @returns Promise that resolves to true if the packet was sent successfully.
   */
  private async sendPacket(packet: Packet): Promise<boolean> {
    if (!this.sendDataFunc) {
      return false;
    }

    try {
      await this.sendDataFunc(packet.serialize());
      return true;
    } catch (error) {
      console.error('Error sending packet:', error);
      return false;
    }
  }

  /**
   * Consumes a packet by processing its type and payload.
   *
   * @param packet - The packet to consume.
   */
  private consumePacket(packet: Packet): void {
    switch (packet.getType()) {
      case MessageType.PONG: {
        console.debug('Received PONG');
        this.pongReceived = true;
        break;
      }

      case MessageType.SERIAL_VARIABLE_MAP_RESPONSE: {
        console.debug('Received SERIAL_VARIABLE_MAP_RESPONSE');
        this.pool.deserializeVarMap(packet.getPayload());
        break;
      }

      case MessageType.SERIAL_VARIABLE: {
        if (!this.isConnected) {
          break; //@todo nao faz sentido so pra testar.
        }
        this.pool.deserializeVariable(packet.getId(), packet.getPayload());
        break;
      }

      case MessageType.DEBUG_LOG: {
        const log = new TextDecoder().decode(packet.getPayload());
        console.log('Received log:', log);
        break;
      }

      case MessageType.ERROR: {
        const errorMessage = new TextDecoder().decode(packet.getPayload());
        console.error('Received error:', errorMessage);
        break;
      }

      default: {
        console.warn('Unknown packet type:', packet.getType());
        break;
      }
    }
  }
}
