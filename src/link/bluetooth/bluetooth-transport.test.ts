import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import type { TransportState } from '../transport';
import { BluetoothTransport } from './bluetooth-transport';
import { GattWriteQueue } from './gatt-write-queue';
import {
  HM19_UART,
  type BluetoothDeviceLike,
  type BluetoothLike,
  type GattCharacteristicLike,
  type GattServerLike,
  type GattServiceLike,
} from './web-bluetooth';

const WRITE_TIME_MS = 5;

class FakeCharacteristic implements GattCharacteristicLike {
  value: DataView | null = null;
  notifying = false;
  readonly writes: Uint8Array[] = [];
  maxInFlight = 0;
  private inFlight = 0;
  private readonly listeners = new Set<() => void>();

  startNotifications(): Promise<this> {
    this.notifying = true;
    return Promise.resolve(this);
  }

  stopNotifications(): Promise<this> {
    this.notifying = false;
    return Promise.resolve(this);
  }

  writeValueWithoutResponse(value: Uint8Array): Promise<void> {
    if (this.inFlight > 0) {
      return Promise.reject(new Error('GATT operation already in progress'));
    }

    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    this.writes.push(value.slice());

    return new Promise((resolve) => {
      setTimeout(() => {
        this.inFlight--;
        resolve();
      }, WRITE_TIME_MS);
    });
  }

  addEventListener(_type: 'characteristicvaluechanged', listener: () => void): void {
    this.listeners.add(listener);
  }

  removeEventListener(_type: 'characteristicvaluechanged', listener: () => void): void {
    this.listeners.delete(listener);
  }

  get listenerCount(): number {
    return this.listeners.size;
  }

  notify(view: DataView): void {
    this.value = view;
    this.listeners.forEach((listener) => listener());
  }
}

class FakeDevice implements BluetoothDeviceLike, GattServerLike, GattServiceLike {
  connected = false;
  connects = 0;
  characteristic = new FakeCharacteristic();
  private readonly listeners = new Set<() => void>();

  constructor(
    readonly id = 'robot-1',
    readonly name = 'MICRAS'
  ) {}

  get gatt(): GattServerLike {
    return this;
  }

  connect(): Promise<GattServerLike> {
    this.connects++;
    this.connected = true;
    this.characteristic = new FakeCharacteristic();
    return Promise.resolve(this);
  }

  disconnect(): void {
    this.connected = false;
  }

  getPrimaryService(uuid: string): Promise<GattServiceLike> {
    return uuid === HM19_UART.service
      ? Promise.resolve(this)
      : Promise.reject(new Error(`No service ${uuid}`));
  }

  getCharacteristic(uuid: string): Promise<GattCharacteristicLike> {
    return uuid === HM19_UART.characteristic
      ? Promise.resolve(this.characteristic)
      : Promise.reject(new Error(`No characteristic ${uuid}`));
  }

  addEventListener(_type: 'gattserverdisconnected', listener: () => void): void {
    this.listeners.add(listener);
  }

  removeEventListener(_type: 'gattserverdisconnected', listener: () => void): void {
    this.listeners.delete(listener);
  }

  get listenerCount(): number {
    return this.listeners.size;
  }

  goOutOfRange(): void {
    this.connected = false;
    this.listeners.forEach((listener) => listener());
  }
}

function fakeBluetooth(device: FakeDevice, withGetDevices: boolean) {
  const requested: unknown[] = [];
  const bluetooth: BluetoothLike = {
    requestDevice: (options) => {
      requested.push(options);
      return Promise.resolve(device);
    },
    ...(withGetDevices ? { getDevices: () => Promise.resolve([device]) } : {}),
  };

  return { bluetooth, requested };
}

async function openTransport(withGetDevices = true) {
  const device = new FakeDevice();
  const { bluetooth, requested } = fakeBluetooth(device, withGetDevices);
  const transport = await BluetoothTransport.request({ bluetooth });
  const states: TransportState[] = [];
  const received: number[][] = [];

  transport.onState((state) => states.push(state));
  transport.onBytes((bytes) => received.push([...bytes]));
  transport.open();
  await vi.advanceTimersByTimeAsync(0);

  return { device, transport, states, received, requested };
}

function ramp(length: number, from = 0): Uint8Array {
  return Uint8Array.from({ length }, (_, index) => (from + index) % 256);
}

function joined(chunks: readonly Uint8Array[]): number[] {
  return chunks.reduce<number[]>((all, chunk) => all.concat(Array.from(chunk)), []);
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('BluetoothTransport', () => {
  test('asks for a device with the UART service and opens its notifications', async () => {
    const { device, transport, requested } = await openTransport();

    expect(requested).toEqual([{ filters: [{ services: [HM19_UART.service] }] }]);
    expect(transport.state).toEqual({ kind: 'open' });
    expect(transport.deviceName).toBe('MICRAS');
    expect(device.characteristic.notifying).toBe(true);
    expect(device.characteristic.listenerCount).toBe(1);
    expect(device.listenerCount).toBe(1);
  });

  test('splits writes into 20 byte chunks, packing frames together', async () => {
    const { device, transport } = await openTransport();

    transport.send(ramp(45));
    transport.send(ramp(3, 45));
    await vi.advanceTimersByTimeAsync(WRITE_TIME_MS * 10);

    const writes = device.characteristic.writes;
    expect(writes.map((write) => write.length)).toEqual([20, 20, 8]);
    expect(joined(writes)).toEqual([...ramp(48)]);
  });

  test('never has two writes in flight', async () => {
    const { device, transport } = await openTransport();

    for (let index = 0; index < 10; index++) {
      transport.send(ramp(7, index * 7));
    }

    await vi.advanceTimersByTimeAsync(WRITE_TIME_MS * 20);

    expect(device.characteristic.maxInFlight).toBe(1);
    expect(joined(device.characteristic.writes)).toEqual([...ramp(70)]);
  });

  test('reads a notification through the offset and length of its view', async () => {
    const { device, received } = await openTransport();
    const buffer = ramp(32).buffer;

    device.characteristic.notify(new DataView(buffer, 8, 5));

    expect(received).toEqual([[8, 9, 10, 11, 12]]);
  });

  test('cleans up after a drop and reconnects through getDevices', async () => {
    const { device, transport, states } = await openTransport();
    const lost = device.characteristic;

    transport.send(ramp(60));
    device.goOutOfRange();

    expect(lost.listenerCount).toBe(0);
    expect(device.listenerCount).toBe(0);
    expect(states.at(-1)).toMatchObject({ kind: 'closed', reason: 'lost', retryInMs: 250 });

    await vi.advanceTimersByTimeAsync(250);

    expect(transport.state).toEqual({ kind: 'open' });
    expect(device.connects).toBe(2);
    expect(device.characteristic.listenerCount).toBe(1);
    expect(device.listenerCount).toBe(1);
    expect(lost.writes.length).toBeLessThan(3);
    expect(device.characteristic.writes).toEqual([]);
  });

  test('without getDevices, a drop waits for a user gesture', async () => {
    const { device, transport } = await openTransport(false);

    device.goOutOfRange();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(transport.state).toMatchObject({ kind: 'closed', reason: 'needs-user-gesture' });
    expect(device.connects).toBe(1);

    transport.reconnect();
    await vi.advanceTimersByTimeAsync(0);

    expect(transport.state).toEqual({ kind: 'open' });
  });

  test('restore finds a device this origin was already given', async () => {
    const device = new FakeDevice('robot-9');
    const { bluetooth } = fakeBluetooth(device, true);

    expect(await BluetoothTransport.restore({ bluetooth }, 'robot-9')).not.toBeNull();
    expect(await BluetoothTransport.restore({ bluetooth }, 'other')).toBeNull();
    expect(
      await BluetoothTransport.restore(
        { bluetooth: fakeBluetooth(device, false).bluetooth },
        'robot-9'
      )
    ).toBeNull();
  });

  test('close stops notifications, disconnects and does not come back', async () => {
    const { device, transport } = await openTransport();
    const characteristic = device.characteristic;

    transport.close();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(characteristic.notifying).toBe(false);
    expect(characteristic.listenerCount).toBe(0);
    expect(device.connected).toBe(false);
    expect(device.connects).toBe(1);
    expect(transport.state).toEqual({ kind: 'closed', reason: 'closed-by-user' });
  });
});

describe('GattWriteQueue', () => {
  test('goes on after a failed write and reports it', async () => {
    const written: number[][] = [];
    const errors: unknown[] = [];
    let first = true;
    const queue = new GattWriteQueue(
      (chunk) => {
        if (first) {
          first = false;
          return Promise.reject(new Error('busy'));
        }

        written.push([...chunk]);
        return Promise.resolve();
      },
      4,
      (error) => errors.push(error)
    );

    queue.push(ramp(10));
    await vi.advanceTimersByTimeAsync(0);

    expect(errors).toHaveLength(1);
    expect(written).toEqual([
      [4, 5, 6, 7],
      [8, 9],
    ]);
    expect(queue.pending).toBe(0);
  });

  test('clear drops what was not written yet', async () => {
    const written: number[][] = [];
    const queue = new GattWriteQueue(
      (chunk) => {
        written.push([...chunk]);
        return new Promise((resolve) => setTimeout(resolve, 5));
      },
      4,
      () => undefined
    );

    queue.push(ramp(12));
    queue.clear();
    await vi.advanceTimersByTimeAsync(50);

    expect(written).toEqual([[0, 1, 2, 3]]);
    expect(queue.pending).toBe(0);
  });
});
