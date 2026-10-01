/**
 * The dedicated worker that owns the saved sessions' files, started with the page so that it
 * is loaded, from the network or the service worker's cache, before REC needs it, while the rest
 * of the sessions code loads later.
 *
 * @module
 */

/** Start the storage worker, or undefined where the browser has no file system for sessions. */
export function startStorageWorker(): Worker | undefined {
  const storage: unknown = Reflect.get(globalThis.navigator ?? {}, 'storage');
  const hasDirectory = typeof storage === 'object' && storage !== null && 'getDirectory' in storage;

  if (typeof Worker === 'undefined' || !hasDirectory) {
    return undefined;
  }

  return new Worker(new URL('./opfs.worker.ts', import.meta.url), {
    type: 'module',
    name: 'micras-monitor-storage',
  });
}
