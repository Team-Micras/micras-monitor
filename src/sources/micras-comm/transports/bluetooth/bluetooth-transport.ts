import { asError } from '../../link/errors';
import { Backoff, DEFAULT_BACKOFF, withTimeout, type BackoffOptions } from '../../link/retry';
import { BaseTransport } from '../transport';
import {
  DEFAULT_CHUNK_SIZE,
  HM19_UART,
  type BluetoothDeviceLike,
  type BluetoothLike,
  type GattCharacteristicLike,
  type UartService,
} from './bluetooth-types';
import { DEFAULT_WRITE_TIMEOUT_MS, GattWriteQueue } from './gatt-write-queue';

/** How a `BluetoothTransport` talks to the module. */
export interface BluetoothTransportOptions {
  /** `navigator.bluetooth`, or a fake of it. */
  bluetooth: BluetoothLike;

  /** Where the UART is in the GATT table; the HM-19's by default. */
  uart?: UartService;

  /** The most bytes one write without response carries. */
  chunkSize?: number;

  /**
   * How long one connection attempt may take, in milliseconds, from connecting to the GATT server
   * to the notifications being on.
   */
  connectTimeoutMs?: number;

  /** How long one write may take, in milliseconds, before the next one goes ahead. */
  writeTimeoutMs?: number;

  /** How the wait between reconnection attempts grows. */
  backoff?: BackoffOptions;
}

const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;

/**
 * A transport over a BLE UART module such as the robot's HM-19.
 *
 * The first connection needs a user gesture, because only one can open the device chooser; that
 * is `BluetoothTransport.request`. After a drop, the transport reconnects to the same device on its own, with
 * backoff. Only when the browser refuses to connect without a gesture does it stop in the
 * `needs-user-gesture` state, and then `reconnect()` has to be called from a click.
 */
export class BluetoothTransport extends BaseTransport {
  private readonly uart: UartService;
  private readonly connectTimeoutMs: number;
  private readonly backoff: Backoff;
  private readonly writes: GattWriteQueue;
  private characteristic: GattCharacteristicLike | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private wanted = false;
  private generation = 0;

  /**
   * Ask the user to choose a robot. Must be called from a user gesture.
   *
   * @param options How to talk to the module.
   * @returns A transport for the chosen device, not yet open.
   */
  static async request(options: BluetoothTransportOptions): Promise<BluetoothTransport> {
    const uart = options.uart ?? HM19_UART;
    const device = await options.bluetooth.requestDevice({
      filters: [{ services: [uart.service] }],
    });

    return new BluetoothTransport(device, options);
  }

  /**
   * @param device The device to connect to.
   * @param options How to talk to the module.
   */
  constructor(
    private readonly device: BluetoothDeviceLike,
    options: BluetoothTransportOptions
  ) {
    super();
    this.uart = options.uart ?? HM19_UART;
    this.connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    this.backoff = new Backoff(options.backoff ?? DEFAULT_BACKOFF);
    this.writes = new GattWriteQueue(
      (chunk) => this.writeChunk(chunk),
      options.chunkSize ?? DEFAULT_CHUNK_SIZE,
      (error) => this.reportError(asError(error)),
      options.writeTimeoutMs ?? DEFAULT_WRITE_TIMEOUT_MS
    );
  }

  open(): void {
    if (this.wanted) {
      return;
    }

    this.wanted = true;
    void this.connect();
  }

  /**
   * Connect again after the transport stopped in `needs-user-gesture`. Must be called from a user
   * gesture.
   */
  reconnect(): void {
    if (this.state.kind === 'open' || this.state.kind === 'connecting') {
      return;
    }

    this.cancelRetry();
    this.wanted = true;
    void this.connect();
  }

  send(bytes: Uint8Array): void {
    if (this.state.kind !== 'open') {
      this.reportNotOpen(bytes);
      return;
    }

    this.writes.push(bytes);
  }

  close(): void {
    this.wanted = false;
    this.cancelRetry();
    this.generation++;

    const characteristic = this.release();
    void characteristic?.stopNotifications().catch(() => undefined);
    this.abandonGatt();
    this.backoff.reset();
    this.setState({ kind: 'closed', reason: 'closed-by-user' });
  }

  private async connect(): Promise<void> {
    const generation = ++this.generation;
    this.retryTimer = undefined;
    this.setState({ kind: 'connecting', attempt: this.backoff.attempts + 1 });

    try {
      await withTimeout(
        this.openUart(generation),
        this.connectTimeoutMs,
        `connecting to ${this.describeDevice()}`
      );

      if (generation === this.generation) {
        this.backoff.reset();
        this.setState({ kind: 'open' });
      }
    } catch (error) {
      if (generation === this.generation) {
        this.generation++;
        this.release();
        this.abandonGatt();
        this.scheduleRetry('failed', error);
      }
    }
  }

  private async openUart(generation: number): Promise<void> {
    const gatt = this.device.gatt;

    if (!gatt) {
      throw new Error(`${this.describeDevice()} has no GATT server`);
    }

    const server = await gatt.connect();
    const service = await server.getPrimaryService(this.uart.service);
    const characteristic = await service.getCharacteristic(this.uart.characteristic);

    if (generation !== this.generation) {
      this.abandonGattUnlessWanted();
      return;
    }

    this.adopt(characteristic);
    await characteristic.startNotifications();
  }

  private adopt(characteristic: GattCharacteristicLike): void {
    this.characteristic = characteristic;
    characteristic.addEventListener('characteristicvaluechanged', this.onNotification);
    this.device.addEventListener('gattserverdisconnected', this.onDisconnected);
  }

  private release(): GattCharacteristicLike | null {
    const characteristic = this.characteristic;

    characteristic?.removeEventListener('characteristicvaluechanged', this.onNotification);
    this.device.removeEventListener('gattserverdisconnected', this.onDisconnected);
    this.characteristic = null;
    this.writes.clear();

    return characteristic;
  }

  private abandonGatt(): void {
    this.device.gatt?.disconnect();
  }

  private abandonGattUnlessWanted(): void {
    if (!this.wanted) {
      this.abandonGatt();
    }
  }

  private readonly onNotification = (): void => {
    const view = this.characteristic?.value;

    if (view) {
      this.receive(new Uint8Array(view.buffer, view.byteOffset, view.byteLength).slice());
    }
  };

  private readonly onDisconnected = (): void => {
    const reason = this.state.kind === 'connecting' ? 'failed' : 'lost';

    this.generation++;
    this.release();
    this.scheduleRetry(reason, new Error(`${this.describeDevice()} disconnected`));
  };

  private writeChunk(chunk: Uint8Array): Promise<void> {
    if (!this.characteristic) {
      return Promise.reject(new Error('Not connected'));
    }

    return this.characteristic.writeValueWithoutResponse(chunk);
  }

  private scheduleRetry(reason: 'lost' | 'failed', error: unknown): void {
    if (!this.wanted) {
      return;
    }

    if (needsUserGesture(error)) {
      this.setState({ kind: 'closed', reason: 'needs-user-gesture', error: asError(error) });
      return;
    }

    const delay = this.backoff.next();
    this.setState({ kind: 'closed', reason, retryInMs: delay, error: asError(error) });
    this.retryTimer = setTimeout(() => void this.connect(), delay);
  }

  private describeDevice(): string {
    return this.device.name ?? this.device.id;
  }

  private cancelRetry(): void {
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
  }
}

/**
 * Whether the browser refused to connect for want of a user gesture, which only a click can fix;
 * anything else is worth retrying.
 */
function needsUserGesture(error: unknown): boolean {
  const { name } = asError(error);
  return name === 'SecurityError' || name === 'NotAllowedError';
}
