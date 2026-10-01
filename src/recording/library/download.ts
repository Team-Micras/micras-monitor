/**
 * Saving an exported session to the user's disk.
 *
 * @module
 */

import type { SessionManager } from './recording-manager';

/** Export a session and hand it to the browser as a download. */
export async function downloadSession(manager: SessionManager, id: string): Promise<void> {
  const exported = await manager.exportSession(id);

  if (exported === null) {
    return;
  }

  const url = URL.createObjectURL(exported.blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = exported.fileName;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
