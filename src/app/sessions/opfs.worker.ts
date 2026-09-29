/**
 * The dedicated worker that holds the Origin Private File System for the page: it answers
 * {@link HostRequest}s with an {@link OpfsHost}, moving read bytes back rather than copying them.
 *
 * @module
 */

import { isHostRequest, OpfsHost, type HostResponse, type OpfsDirectory } from './opfs-host';

interface WorkerScope {
  postMessage(message: HostResponse, transfer: Transferable[]): void;
  addEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void;
}

interface StorageRoot {
  readonly storage: { getDirectory(): Promise<OpfsDirectory> };
}

function isWorkerScope(scope: unknown): scope is WorkerScope {
  return typeof scope === 'object' && scope !== null && 'postMessage' in scope;
}

function hasStorage(value: unknown): value is StorageRoot {
  return typeof value === 'object' && value !== null && 'storage' in value;
}

const scope: unknown = globalThis;
const navigator: unknown = globalThis.navigator;

if (isWorkerScope(scope) && hasStorage(navigator)) {
  const { storage } = navigator;
  const host = new OpfsHost(() => storage.getDirectory());

  scope.addEventListener('message', (event) => {
    if (!isHostRequest(event.data)) {
      return;
    }

    void host.handle(event.data).then((response) => {
      const value = response.ok ? response.value : null;
      const moved = value instanceof Uint8Array && value.buffer instanceof ArrayBuffer;
      scope.postMessage(response, moved ? [value.buffer] : []);
    });
  });
}
