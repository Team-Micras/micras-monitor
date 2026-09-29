/**
 * The sessions of the app in a browser: the Origin Private File System through its worker where
 * the browser has one, memory otherwise, and Web Locks between tabs.
 *
 * @module
 */

import type { Scheduler, TelemetryStore } from '@/telemetry';

import type { MonitorPorts } from '../ports';
import { MemorySessionLibrary } from './memory-library';
import { MessageTransport, OpfsSessionLibrary, type StorageManagerLike } from './opfs-library';
import {
  MemoryLocks,
  WebLocks,
  type LockManagerLike,
  type SessionLibrary,
  type SessionLocks,
} from './session-library';
import { recordedSchema, SessionManager, type RobotDescription } from './session-manager';

interface NavigatorLike {
  readonly storage?: StorageManagerLike & { readonly getDirectory?: unknown };
  readonly locks?: LockManagerLike;
}

function browserNavigator(): NavigatorLike {
  const value: unknown = globalThis.navigator;
  return typeof value === 'object' && value !== null ? value : {};
}

function storageWorker(): Worker {
  return new Worker(new URL('./opfs.worker.ts', import.meta.url), {
    type: 'module',
    name: 'micras-monitor-storage',
  });
}

function library(): SessionLibrary {
  const { storage } = browserNavigator();

  if (typeof Worker === 'undefined' || typeof storage?.getDirectory !== 'function') {
    return new MemorySessionLibrary();
  }

  const transport = new MessageTransport(storageWorker);
  void transport.call({ op: 'list' }).catch(() => undefined);
  return new OpfsSessionLibrary(transport, storage);
}

function locks(): SessionLocks {
  const { locks: manager } = browserNavigator();
  return manager === undefined ? new MemoryLocks() : new WebLocks(manager);
}

/** What a recording's header says of the robot the ports reach, as it is now. */
export function describeRobot(ports: MonitorPorts): RobotDescription {
  const status = ports.connection.status();
  const identity = status.kind === 'linked' ? status.robot : null;
  return {
    name: identity?.name ?? null,
    robot: {
      name: identity?.name ?? null,
      schemaHash: identity?.schemaHash ?? null,
      transport: 'target' in status ? status.target.transport : null,
    },
    schema: recordedSchema(ports.schema.variables()),
  };
}

/**
 * The sessions of the robot behind the ports, recovering what a closed tab left behind as they
 * start.
 *
 * @param store The live store.
 * @param ports The live robot's ports.
 * @param scheduler When opened sessions tell their readers about changes.
 * @param viewCapBytes The memory cap of an opened session; a share of the live store's otherwise.
 */
export function browserSessions(
  store: TelemetryStore,
  ports: MonitorPorts,
  scheduler: Scheduler,
  viewCapBytes?: number
): SessionManager {
  const manager = new SessionManager({
    store,
    library: library(),
    locks: locks(),
    scheduler,
    viewCapBytes,
    describe: () => describeRobot(ports),
  });
  void manager.start();
  return manager;
}
