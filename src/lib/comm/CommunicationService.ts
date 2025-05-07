import { Packet } from "./Packet";
import { SerialVariablePool } from "./SerialVariablePool";
import { ISerialVariable } from "./variables/ISerialVariable";

/**
 * Type definitions for communication functions
 */
export type SendDataFunction = (data: Uint8Array) => Promise<void>;
export type GetDataFunction = () => Promise<Uint8Array>;

/**
 * Class for controlling the communication service
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
   * Creates a new CommunicationService instance
   *
   * @param pool - The serial variable pool to manage variables
   * @param onConnectionStatusChange - Optional callback for connection status changes
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
   * Registers the communication functions for sending and receiving data
   *
   * @param sendFunc - Function for sending data
   * @param getFunc - Function for receiving data
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
   * Starts the periodic update and connection verification tasks
   *
   * @param interval - The update interval in milliseconds
   */
  startCommunication(interval: number = 10): void {
    this.stopCommunication();

    this.receiveDataTask = window.setInterval(() => {
      this.update();
    }, interval);

    this.startConnectionVerification();
  }

  /**
   * Stops all periodic tasks
   */
  stopCommunication(): void {
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
   * Updates the communication service by processing incoming packets
   */
  private async update(): Promise<void> {
    if (!this.functionsRegistered) {
      console.warn("Communication functions not registered");
      return;
    }

    await this.updateIncomingPackets();
    this.processIncomingPackets();
  }

  /**
   * Starts the connection verification task that sends pings periodically
   * to check if the connection is still active
   *
   * @param interval - The verification interval in milliseconds
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
   * Clears a connection check timeout and removes it from the list
   *
   * @param timeoutId - The ID of the timeout to clear
   */
  private clearConnectionCheckTimeout(timeoutId: number): void {
    const index = this.connectionCheckTimeouts.indexOf(timeoutId);
    if (index !== -1) {
      this.connectionCheckTimeouts.splice(index, 1);
    }
  }

  /**
   * Stops the connection verification task and clears any pending timeouts
   */
  private stopConnectionVerification(): void {
    if (this.verifyConnectionTask !== undefined) {
      clearInterval(this.verifyConnectionTask);
      this.verifyConnectionTask = undefined;
    }

    // Clear any pending connection check timeouts
    this.connectionCheckTimeouts.forEach((timeoutId) => {
      clearTimeout(timeoutId);
    });
    this.connectionCheckTimeouts = [];
  }

  /**
   * Sends a ping packet to the remote device
   */
  private ping(): void {
    this.sendPacket(new Packet(Packet.MessageType.PING));
  }

  /**
   * Requests the variable map from the remote device
   */
  private requestVariableMap(): void {
    this.sendPacket(new Packet(Packet.MessageType.SERIAL_VARIABLE_MAP_REQUEST));
  }

  /**
   * Sends a variable update to the remote device
   *
   * @param id - The ID of the variable
   * @param variable - The variable to send
   */
  private sendVariable(id: number, variable: ISerialVariable): void {
    this.sendPacket(
      new Packet(Packet.MessageType.SERIAL_VARIABLE, id, variable.serialize())
    );
  }

  /**
   * Updates the connection status and notifies listeners if it has changed
   *
   * @param status - The new connection status
   */
  private setConnectionStatus(status: boolean): void {
    if (this.isConnected !== status) {
      this.isConnected = status;

      if (this.onConnectionStatusChange) {
        this.onConnectionStatusChange(status);
      }
    }
  }

  /**
   * Updates the incoming packets queue by fetching data from the source
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
      console.error("Error updating incoming packets:", error);
    }
  }

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

  private extractValidPacket(): Uint8Array {
    const queue = this.incomingDataQueue;
    let startIndex = 0;

    while (
      startIndex < queue.length &&
      queue[startIndex] !== Packet.HEADER_BYTE
    ) {
      if (queue[startIndex] === Packet.ESCAPE_BYTE) {
        startIndex++;
      }

      startIndex++;
    }

    return new Uint8Array(queue.slice(startIndex));
  }

  private processIncomingPackets(): void {
    while (this.incomingPackets.length > 0) {
      const packet = this.incomingPackets.shift()!;
      this.consumePacket(packet);
    }
  }

  /**
   * Sends a packet to the remote device
   *
   * @param packet - The packet to send
   * @returns Promise that resolves to true if the packet was sent successfully
   */
  private async sendPacket(packet: Packet): Promise<boolean> {
    if (!this.sendDataFunc) {
      return false;
    }

    try {
      await this.sendDataFunc(packet.serialize());
      return true;
    } catch (error) {
      console.error("Error sending packet:", error);
      return false;
    }
  }

  private consumePacket(packet: Packet): void {
    switch (packet.getType()) {
      case Packet.MessageType.PONG:
        this.pongReceived = true;
        break;

      case Packet.MessageType.SERIAL_VARIABLE_MAP_RESPONSE:
        console.debug("Received variable map response");
        this.pool.deserializeVarMap(packet.getPayload());
        break;

      case Packet.MessageType.SERIAL_VARIABLE:
        console.debug(`Received variable with ID: ${packet.getId()}`);
        this.pool.deserializeVariable(packet.getId(), packet.getPayload());
        break;

      case Packet.MessageType.DEBUG_LOG:
        const log = new TextDecoder().decode(packet.getPayload());
        console.debug("Received log:", log);
        break;

      case Packet.MessageType.ERROR:
        const errorMessage = new TextDecoder().decode(packet.getPayload());
        console.error("Received error:", errorMessage);
        break;

      default:
        console.warn("Unknown packet type:", packet.getType());
        break;
    }
  }

  /**
   * Returns whether the service is currently connected to a remote device
   */
  public isServiceConnected(): boolean {
    return this.isConnected;
  }
}
