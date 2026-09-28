import { Backoff, DEFAULT_BACKOFF, type BackoffOptions } from './backoff';
import { asError, BaseTransport } from './transport';

/**
 * The part of a WebSocket the transport uses, which the browser's, Bun's and Node's all provide
 * and which a test can fake.
 */
export interface WebSocketLike {
  binaryType: string;
  addEventListener(type: WebSocketEventType, listener: (event: unknown) => void): void;
  removeEventListener(type: WebSocketEventType, listener: (event: unknown) => void): void;
  send(data: Uint8Array): void;
  close(code?: number, reason?: string): void;
}

/** The socket events the transport listens to. */
export type WebSocketEventType = 'open' | 'close' | 'error' | 'message';

/** Opens a socket to a URL. */
export type WebSocketFactory = (url: string) => WebSocketLike;

/** How a `WebSocketTransport` connects. */
export interface WebSocketTransportOptions {
  /** Opens the socket; the runtime's own `WebSocket` by default. */
  createSocket?: WebSocketFactory;

  /** How the wait between reconnection attempts grows. */
  backoff?: BackoffOptions;
}

const NORMAL_CLOSURE = 1000;

/**
 * A transport over a WebSocket, which is how the simulation's bridge exposes the robot's radio.
 *
 * Every attempt opens a fresh socket, and a socket that closed is let go of entirely, handlers
 * and all, so that nothing from a dead connection reaches a live one. The backoff only starts over
 * once bytes arrive, so a server that accepts and hangs up at once is not hammered.
 */
export class WebSocketTransport extends BaseTransport {
  private readonly createSocket: WebSocketFactory;
  private readonly backoff: Backoff;
  private socket: WebSocketLike | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private wanted = false;
  private opened = false;

  /**
   * @param url Where the bridge listens, such as `ws://localhost:8080`.
   * @param options How to connect.
   */
  constructor(
    readonly url: string,
    options: WebSocketTransportOptions = {}
  ) {
    super();
    this.createSocket = options.createSocket ?? runtimeWebSocket;
    this.backoff = new Backoff(options.backoff ?? DEFAULT_BACKOFF);
  }

  open(): void {
    if (this.wanted) {
      return;
    }

    this.wanted = true;
    this.connect();
  }

  send(bytes: Uint8Array): void {
    if (this.state.kind !== 'open' || !this.socket) {
      this.reportNotOpen(bytes);
      return;
    }

    this.socket.send(bytes);
  }

  close(): void {
    this.wanted = false;
    this.cancelRetry();
    this.release()?.close(NORMAL_CLOSURE);
    this.backoff.reset();
    this.setState({ kind: 'closed', reason: 'closed-by-user' });
  }

  private connect(): void {
    this.retryTimer = undefined;
    this.setState({ kind: 'connecting', attempt: this.backoff.attempts + 1 });

    try {
      this.attach(this.createSocket(this.url));
    } catch (error) {
      this.scheduleRetry('failed', error);
    }
  }

  private attach(socket: WebSocketLike): void {
    this.socket = socket;
    this.opened = false;
    socket.binaryType = 'arraybuffer';

    for (const [type, listener] of this.listeners) {
      socket.addEventListener(type, listener);
    }
  }

  private readonly onOpen = (): void => {
    this.opened = true;
    this.setState({ kind: 'open' });
  };

  private readonly onSocketMessage = (event: unknown): void => {
    this.backoff.reset();
    this.onMessage(isRecord(event) ? event.data : undefined);
  };

  private readonly onSocketError = (): void => {
    this.reportError(new Error(`WebSocket error on ${this.url}`));
  };

  private readonly onClose = (event: unknown): void => {
    this.release();
    this.scheduleRetry(
      this.opened ? 'lost' : 'failed',
      new Error(`WebSocket closed (${describeClose(event)})`)
    );
  };

  private readonly listeners: [WebSocketEventType, (event: unknown) => void][] = [
    ['open', this.onOpen],
    ['message', this.onSocketMessage],
    ['error', this.onSocketError],
    ['close', this.onClose],
  ];

  private onMessage(data: unknown): void {
    if (data instanceof ArrayBuffer) {
      this.receive(new Uint8Array(data));
    } else if (ArrayBuffer.isView(data)) {
      this.receive(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    } else {
      this.reportError(new Error(`Ignored a ${typeof data} message; the bridge only sends bytes`));
    }
  }

  private scheduleRetry(reason: 'lost' | 'failed', error: unknown): void {
    if (!this.wanted) {
      return;
    }

    const delay = this.backoff.next();
    this.setState({
      kind: 'closed',
      reason,
      retryInMs: delay,
      error: asError(error),
    });
    this.retryTimer = setTimeout(() => this.connect(), delay);
  }

  private cancelRetry(): void {
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
  }

  private release(): WebSocketLike | null {
    const socket = this.socket;

    for (const [type, listener] of this.listeners) {
      socket?.removeEventListener(type, listener);
    }

    this.socket = null;
    return socket;
  }
}

function runtimeWebSocket(url: string): WebSocketLike {
  const Constructor: unknown = Reflect.get(globalThis, 'WebSocket');

  if (!isWebSocketConstructor(Constructor)) {
    throw new Error('This runtime has no WebSocket');
  }

  return new Constructor(url);
}

function isWebSocketConstructor(value: unknown): value is new (url: string) => WebSocketLike {
  return typeof value === 'function';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function describeClose(event: unknown): string {
  const code = isRecord(event) && typeof event.code === 'number' ? event.code : 'no code';
  const reason = isRecord(event) && typeof event.reason === 'string' ? event.reason : '';
  return reason ? `${code}: ${reason}` : String(code);
}
