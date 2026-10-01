import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import type { WebSocketLike } from '@/sources/micras-comm/link';
import { startInMemoryRobot } from '@tests/support/sources/micras-comm/in-memory-robot';

function listen(socket: WebSocketLike): string[] {
  const events: string[] = [];
  for (const type of ['open', 'error', 'close'] as const) {
    socket.addEventListener(type, (event) => {
      const code: unknown = Reflect.get(Object(event), 'code');
      events.push(typeof code === 'number' ? `${type} ${code}` : type);
    });
  }
  return events;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('The in-memory robot', () => {
  test('opens a socket on a later turn and closes it normally', () => {
    const sim = startInMemoryRobot();
    const socket = sim.createSocket('ws://in-memory');
    const events = listen(socket);
    vi.advanceTimersByTime(1);
    socket.close();
    vi.advanceTimersByTime(1);
    expect(events).toEqual(['open', 'close 1000']);
  });

  test('throws on a send before the socket opened, as a browser does', () => {
    const sim = startInMemoryRobot();
    const socket = sim.createSocket('ws://in-memory');
    expect(() => socket.send(new Uint8Array([1]))).toThrow(
      expect.objectContaining({ name: 'InvalidStateError' })
    );
    vi.advanceTimersByTime(1);
    expect(() => socket.send(new Uint8Array([1]))).not.toThrow();
  });

  test('drops the open sockets when it closes and refuses new ones with an error', () => {
    const sim = startInMemoryRobot();
    const open = listen(sim.createSocket('ws://in-memory'));
    vi.advanceTimersByTime(1);
    sim.close();
    vi.advanceTimersByTime(1);
    const refused = listen(sim.createSocket('ws://in-memory'));
    vi.advanceTimersByTime(1);
    expect(open).toEqual(['open', 'close 1006']);
    expect(refused).toEqual(['error', 'close 1006']);
    expect(sim.robot).toBeUndefined();
  });
});
