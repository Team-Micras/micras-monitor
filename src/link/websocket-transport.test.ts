import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import type { TransportState } from './transport';
import {
  WebSocketTransport,
  type WebSocketEventType,
  type WebSocketLike,
} from './websocket-transport';

class FakeSocket implements WebSocketLike {
  binaryType = 'blob';
  readonly sent: Uint8Array[] = [];
  closedWith: number | undefined;
  private readonly listeners = new Map<WebSocketEventType, Set<(event: unknown) => void>>();

  addEventListener(type: WebSocketEventType, listener: (event: unknown) => void): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }

  removeEventListener(type: WebSocketEventType, listener: (event: unknown) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  send(data: Uint8Array): void {
    this.sent.push(data);
  }

  close(code?: number): void {
    this.closedWith = code;
  }

  get listenerCount(): number {
    return [...this.listeners.values()].reduce((total, set) => total + set.size, 0);
  }

  fire(type: WebSocketEventType, event: unknown = {}): void {
    this.listeners.get(type)?.forEach((listener) => listener(event));
  }

  accept(): void {
    this.fire('open');
  }

  drop(code = 1006): void {
    this.fire('close', { code, reason: '' });
  }
}

function setup() {
  const sockets: FakeSocket[] = [];
  const transport = new WebSocketTransport('ws://robot', {
    createSocket: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
  });
  const states: TransportState[] = [];
  const received: number[][] = [];
  const errors: Error[] = [];

  transport.onState((state) => states.push(state));
  transport.onBytes((bytes) => received.push([...bytes]));
  transport.onError((error) => errors.push(error));

  return {
    transport,
    sockets,
    states,
    received,
    errors,
    latest: () => sockets[sockets.length - 1],
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('WebSocketTransport', () => {
  test('opens a binary socket and pushes what arrives', () => {
    const { transport, latest, received } = setup();

    transport.open();
    expect(transport.state).toEqual({ kind: 'connecting', attempt: 1 });

    latest().accept();
    latest().fire('message', { data: new Uint8Array([1, 2, 3]).buffer });
    latest().fire('message', { data: new Uint8Array([9, 4, 5, 6]).subarray(1) });

    expect(latest().binaryType).toBe('arraybuffer');
    expect(transport.state).toEqual({ kind: 'open' });
    expect(received).toEqual([
      [1, 2, 3],
      [4, 5, 6],
    ]);
  });

  test('sends only while open and reports what it dropped', () => {
    const { transport, latest, errors } = setup();

    transport.open();
    transport.send(new Uint8Array([1]));
    latest().accept();
    transport.send(new Uint8Array([2]));

    expect(latest().sent).toEqual([new Uint8Array([2])]);
    expect(errors).toHaveLength(1);
  });

  test('reports socket errors', () => {
    const { transport, latest, errors } = setup();

    transport.open();
    latest().fire('error');

    expect(errors[0].message).toContain('ws://robot');
  });

  test('reconnects on a fresh socket after a drop, letting go of the old one', () => {
    const { transport, sockets, latest } = setup();

    transport.open();
    latest().accept();
    const first = latest();
    first.drop();

    expect(transport.state).toMatchObject({ kind: 'closed', reason: 'lost', retryInMs: 250 });
    expect(first.listenerCount).toBe(0);

    vi.advanceTimersByTime(249);
    expect(sockets).toHaveLength(1);

    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(2);
    expect(latest()).not.toBe(first);

    latest().accept();
    expect(transport.state).toEqual({ kind: 'open' });
  });

  test('backs off exponentially up to a cap, and starts over once bytes arrive', () => {
    const { transport, latest, states } = setup();
    const delays = () =>
      states.flatMap((state) =>
        state.kind === 'closed' && state.retryInMs ? [state.retryInMs] : []
      );

    transport.open();

    for (let attempt = 0; attempt < 7; attempt++) {
      latest().drop();
      vi.advanceTimersByTime(5000);
    }

    expect(delays()).toEqual([250, 500, 1000, 2000, 4000, 5000, 5000]);
    expect(
      states.filter((state) => state.kind === 'closed').every((state) => state.reason === 'failed')
    ).toBe(true);

    latest().accept();
    latest().drop();
    expect(delays().at(-1)).toBe(5000);

    vi.advanceTimersByTime(5000);
    latest().accept();
    latest().fire('message', { data: new Uint8Array([1]).buffer });
    latest().drop();
    expect(delays().at(-1)).toBe(250);
  });

  test('retries when the socket cannot even be created', () => {
    let calls = 0;
    const transport = new WebSocketTransport('ws://robot', {
      createSocket: () => {
        calls++;
        throw new Error('bad url');
      },
    });

    transport.open();
    expect(transport.state).toMatchObject({ kind: 'closed', reason: 'failed', retryInMs: 250 });

    vi.advanceTimersByTime(250);
    expect(calls).toBe(2);
    transport.close();
  });

  test('close stops reconnecting and releases the socket', () => {
    const { transport, sockets, latest } = setup();

    transport.open();
    latest().accept();
    const socket = latest();
    transport.close();
    socket.drop();
    vi.advanceTimersByTime(60_000);

    expect(socket.closedWith).toBe(1000);
    expect(socket.listenerCount).toBe(0);
    expect(sockets).toHaveLength(1);
    expect(transport.state).toEqual({ kind: 'closed', reason: 'closed-by-user' });
  });

  test('close during a pending retry cancels it', () => {
    const { transport, sockets, latest } = setup();

    transport.open();
    latest().drop();
    transport.close();
    vi.advanceTimersByTime(60_000);

    expect(sockets).toHaveLength(1);
  });
});
