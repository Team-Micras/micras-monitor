import { MemoryStickIcon, XIcon } from 'lucide-react';

import { Button } from '../components/ui/button';
import { formatBytes } from '../lib/format';
import type { MemoryNotice as Notice } from './session-manager';
import { useSessionManager, useSessions } from './sessions-context';

function describe(notice: Notice, recording: boolean): { title: string; detail: string } {
  const cap = formatBytes(notice.capBytes);

  switch (notice.kind) {
    case 'warning':
      return {
        title: `History at ${Math.round((100 * notice.usedBytes) / notice.capBytes)}% of its ${cap}`,
        detail: recording
          ? 'Recorded blocks leave memory and come back from the file when scrolled to'
          : 'At the cap the oldest history is dropped; REC keeps all of it',
      };
    case 'dropped':
      return {
        title: 'The oldest history was dropped',
        detail: `The ${cap} cap was reached; the plots mark the stretch as not stored`,
      };
    default:
      return {
        title: 'History paused at the memory cap',
        detail: 'Live values go on; history resumes once written blocks can leave memory',
      };
  }
}

/** What the memory cap did to the live history: nearing it, dropping the oldest, or pausing. */
export function MemoryNotice() {
  const manager = useSessionManager();
  const state = useSessions();
  const notice = state?.memory ?? null;

  if (manager === null || notice === null) {
    return null;
  }

  const { title, detail } = describe(notice, state?.recording !== null);

  return (
    <output
      aria-label="Memory"
      data-memory-notice={notice.kind}
      className="pointer-events-auto flex max-w-md items-center gap-3 rounded-xl border bg-popover py-1.5 pr-1.5 pl-3.5 text-sm text-popover-foreground shadow-md"
    >
      <MemoryStickIcon className="size-4 shrink-0 text-amber-500" aria-hidden />
      <span className="min-w-0">
        <span className="block truncate font-medium">{title}</span>
        <span className="block truncate text-xs text-muted-foreground">{detail}</span>
      </span>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Dismiss"
        onClick={() => manager.dismissMemory()}
      >
        <XIcon />
      </Button>
    </output>
  );
}
