/**
 * The recordings of the app in a browser: the Origin Private File System through its worker where
 * the browser has one, memory otherwise, and Web Locks between tabs.
 *
 * @module
 */

import type { Monitor } from '@/core/monitor';
import type { HistoryStore, Scheduler } from '@/history';

import { MemoryRecordingLibrary } from './memory-library';
import { MessageTransport, OpfsRecordingLibrary, type StorageManagerLike } from './opfs-library';
import {
  MemoryLocks,
  WebLocks,
  type LockManagerLike,
  type RecordingLibrary,
  type RecordingLocks,
} from './recording-library';
import { RecordingManager, type RobotDescription } from './recording-manager';
import { startStorageWorker } from './storage-worker';

interface NavigatorLike {
  readonly storage?: StorageManagerLike & { readonly getDirectory?: unknown };
  readonly locks?: LockManagerLike;
}

function browserNavigator(): NavigatorLike {
  const value: unknown = globalThis.navigator;
  return typeof value === 'object' && value !== null ? value : {};
}

function library(started: Worker | undefined): RecordingLibrary {
  const { storage } = browserNavigator();

  if (started === undefined || storage === undefined) {
    return new MemoryRecordingLibrary();
  }

  let first: Worker | undefined = started;
  const transport = new MessageTransport(() => {
    const worker = first ?? startStorageWorker();
    first = undefined;

    if (worker === undefined) {
      throw new Error('This browser cannot start the storage worker');
    }

    return worker;
  });
  return new OpfsRecordingLibrary(transport, storage);
}

function locks(): RecordingLocks {
  const { locks: manager } = browserNavigator();
  return manager === undefined ? new MemoryLocks() : new WebLocks(manager);
}

/** What a recording's header says of the robot a monitor reaches, as it is now. */
export function describeRobot(monitor: Monitor<HistoryStore>): RobotDescription {
  const { status, identity, variables } = monitor.state;
  return {
    name: identity?.name ?? null,
    robot: {
      name: identity?.name ?? null,
      schema: identity?.schema ?? null,
      transport: 'target' in status ? status.target.transport : null,
    },
    schema: variables,
  };
}

/**
 * The sessions of the live robot, recovering what a closed tab left behind as they start.
 *
 * @param monitor The live monitor, whose history REC records.
 * @param scheduler When opened sessions tell their readers about changes.
 * @param worker The storage worker started with the page, if the browser has a file system for
 *   sessions; they are kept in memory otherwise.
 * @param viewCapBytes The memory cap of an opened session; a share of the live store's otherwise.
 */
export function browserRecordings(
  monitor: Monitor<HistoryStore>,
  scheduler: Scheduler,
  worker: Worker | undefined,
  viewCapBytes?: number
): RecordingManager {
  const manager = new RecordingManager({
    store: monitor.history,
    library: library(worker),
    locks: locks(),
    scheduler,
    viewCapBytes,
    describe: () => describeRobot(monitor),
  });
  void manager.start();
  return manager;
}
